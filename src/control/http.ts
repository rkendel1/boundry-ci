// Control-plane HTTP API (node:http, no framework).
//   POST /webhooks/github                         GitHub App webhook (HMAC verified)
//   POST /v1/worker/register|lease                worker bearer token
//   POST /v1/attempts/:id/start|heartbeat|logs|complete
//   PUT  /v1/artifacts/sha256/:hex                worker bearer token, content-addressed upload
//   GET  /v1/runs/:id  /v1/runs/:id/jobs  /v1/attempts/:id/log
//   POST /v1/runs/:id/cancel  /v1/jobs/:id/approve  /v1/dispatch    operator bearer token
//   GET  /healthz  /readyz
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { timingSafeEqual, createHash, randomUUID } from "node:crypto";
import { ControlPlane, C, artifactIdOf, AuthorityError, NotFound, Conflict, type WorkerRec, type RunRec } from "./core.ts";
import { ContentStore, DigestMismatch, StorageExhausted, TooLarge } from "../artifacts/cas.ts";
import { verifyWebhookSignature, normalizeGithubEvent } from "../scm/github.ts";
import { PreconditionFailed, StoreUnavailable } from "../store/feltdb.ts";

export interface HttpOptions {
  cp: ControlPlane;
  cas: ContentStore;
  webhookSecret: string;
  /** sha256 hex of operator tokens -> operator identity */
  operators: Record<string, string>;
  log?: (msg: string, fields?: Record<string, unknown>) => void;
}

class HttpError extends Error { readonly status: number; constructor(status: number, msg: string) { super(msg); this.status = status; } }

const MAX_JSON = 512 * 1024;

async function readBody(req: IncomingMessage, max: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of req) {
    n += (c as Buffer).length;
    if (n > max) throw new HttpError(413, "body too large");
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}

function send(res: ServerResponse, status: number, obj: unknown) {
  const b = JSON.stringify(obj);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(b) });
  res.end(b);
}

const bearer = (req: IncomingMessage) => {
  const h = req.headers.authorization ?? "";
  return h.startsWith("Bearer ") ? h.slice(7) : "";
};

export function createControlServer(o: HttpOptions): Server {
  const { cp, cas } = o;
  const log = o.log ?? (() => {});

  const worker = async (req: IncomingMessage): Promise<WorkerRec> => {
    const t = bearer(req);
    if (!t) throw new HttpError(401, "worker token required");
    try { return await cp.authenticateWorker(t); } catch { throw new HttpError(401, "invalid worker token"); }
  };
  const operator = (req: IncomingMessage): string => {
    const t = bearer(req);
    const h = createHash("sha256").update(t).digest("hex");
    for (const [hash, who] of Object.entries(o.operators)) {
      if (t && hash.length === h.length && timingSafeEqual(Buffer.from(hash), Buffer.from(h))) return who;
    }
    throw new HttpError(401, "operator token required");
  };
  const json = async (req: IncomingMessage) => {
    const b = await readBody(req, MAX_JSON);
    try { return b.length ? JSON.parse(b.toString("utf8")) : {}; } catch { throw new HttpError(400, "invalid JSON"); }
  };

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const p = url.pathname;
    const m = (re: RegExp) => re.exec(p);
    try {
      if (req.method === "GET" && p === "/healthz") return send(res, 200, { ok: true });
      if (req.method === "GET" && p === "/readyz") return send(res, (await cp.store.ready()) ? 200 : 503, { feltdb: await cp.store.ready() });

      if (req.method === "POST" && p === "/webhooks/github") {
        const raw = await readBody(req, 25 * 1024 * 1024);
        if (!verifyWebhookSignature(o.webhookSecret, raw, req.headers["x-hub-signature-256"] as string | undefined)) throw new HttpError(401, "bad signature");
        const delivery = String(req.headers["x-github-delivery"] ?? "");
        const event = String(req.headers["x-github-event"] ?? "");
        let payload: unknown;
        try { payload = JSON.parse(raw.toString("utf8")); } catch { throw new HttpError(400, "invalid JSON"); }
        const ev = normalizeGithubEvent(event, delivery, payload);
        if (!ev) return send(res, 202, { ignored: true, event });
        const r = await cp.intake(ev);
        log("intake", { delivery, event, repository: ev.repository, ...r });
        return send(res, r.duplicate ? 200 : 201, r);
      }

      if (req.method === "POST" && p === "/v1/worker/register") {
        const w = await worker(req);
        const b = await json(req);
        const caps = await cp.registerWorker(w, Array.isArray(b.capabilities) ? b.capabilities.map(String) : [], b.resources ?? {});
        return send(res, 200, { workerId: w.id, capabilities: caps, leaseMs: cp.leaseMs });
      }
      if (req.method === "POST" && p === "/v1/worker/lease") {
        const w = await worker(req);
        const fresh = (await cp.store.get<WorkerRec>(C.workers, w.id))!;
        const grant = await cp.lease(fresh);
        return grant ? send(res, 200, grant) : send(res, 204, {});
      }
      let mm = m(/^\/v1\/attempts\/([^/]+)\/(start|heartbeat|logs|complete)$/);
      if (req.method === "POST" && mm) {
        const w = await worker(req);
        const id = decodeURIComponent(mm[1]);
        const b = await json(req);
        switch (mm[2]) {
          case "start": return send(res, 200, await cp.start(w.id, id, String(b.leaseId)));
          case "heartbeat": return send(res, 200, await cp.heartbeat(w.id, id, String(b.leaseId)));
          case "logs": await cp.appendLog(w.id, id, Number(b.seq), String(b.data)); return send(res, 200, { ok: true });
          case "complete": return send(res, 200, await cp.complete(w.id, id, String(b.leaseId), b.result));
        }
      }
      mm = m(/^\/v1\/artifacts\/sha256\/([0-9a-f]{64})$/);
      if (req.method === "PUT" && mm) {
        const w = await worker(req);
        const hex = mm[1];
        const declared = req.headers["content-length"] ? Number(req.headers["content-length"]) : undefined;
        const { size, created } = await cas.put(req, hex, declared);
        const id = artifactIdOf(hex);
        try {
          await cp.store.transact(`artifact:${id}`, [{ collection: C.artifacts, id, requireAbsent: true, value: { size, storedAt: cp.now(), firstUploader: w.id } }]);
        } catch (e) { if (!(e instanceof PreconditionFailed)) throw e; }
        return send(res, created ? 201 : 200, { digest: hex, size });
      }
      mm = m(/^\/v1\/artifacts\/sha256\/([0-9a-f]{64})$/);
      if (req.method === "GET" && mm) {
        operator(req);
        if (!cas.has(mm[1])) throw new HttpError(404, "not found");
        res.writeHead(200, { "content-type": "application/octet-stream" });
        return void cas.open(mm[1]).pipe(res);
      }

      mm = m(/^\/v1\/runs\/([^/]+)$/);
      if (req.method === "GET" && mm) {
        operator(req);
        const r = await cp.store.get<RunRec>(C.runs, mm[1]);
        if (!r) throw new HttpError(404, "not found");
        return send(res, 200, r);
      }
      mm = m(/^\/v1\/runs\/([^/]+)\/jobs$/);
      if (req.method === "GET" && mm) {
        operator(req);
        const jobs = await cp.store.query(C.jobs, [{ field: "runId", eq: mm[1] }], { limit: 1000 });
        return send(res, 200, jobs.map(({ spec, ...j }: any) => ({ ...j, requires: spec.requires, needs: spec.needs })));
      }
      mm = m(/^\/v1\/runs\/([^/]+)\/statuses$/);
      if (req.method === "GET" && mm) {
        operator(req);
        const rows = await cp.store.query(C.outbox, [{ field: "runId", eq: mm[1] }], { limit: 1000, orderBy: [{ field: "createdAt", direction: "asc" }] });
        return send(res, 200, rows.map((r: any) => ({ context: r.context, state: r.state, delivered: r.delivered, attempts: r.attempts, lastError: r.lastError ?? null })));
      }
      mm = m(/^\/v1\/attempts\/([^/]+)\/log$/);
      if (req.method === "GET" && mm) {
        operator(req);
        const text = await cp.readLog(decodeURIComponent(mm[1]));
        res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
        return res.end(text);
      }
      mm = m(/^\/v1\/runs\/([^/]+)\/cancel$/);
      if (req.method === "POST" && mm) {
        const who = operator(req);
        await cp.cancelRun(mm[1], who);
        return send(res, 200, { ok: true });
      }
      mm = m(/^\/v1\/jobs\/([^/]+)\/approve$/);
      if (req.method === "POST" && mm) {
        const who = operator(req);
        await cp.approve(decodeURIComponent(mm[1]), who);
        return send(res, 200, { ok: true });
      }
      if (req.method === "POST" && p === "/v1/dispatch") {
        const who = operator(req);
        const b = await json(req);
        const branch = String(b.branch ?? "main");
        const sha = b.sha ? String(b.sha) : await cp.scm.resolveBranch(String(b.repository), branch);
        if (!sha) throw new HttpError(404, "branch not found");
        const r = await cp.intake({ provider: "boundry", deliveryId: `manual:${b.requestId ? String(b.requestId) : randomUUID()}`, kind: "manual", repository: String(b.repository), ref: `refs/heads/${branch}`, sha, trusted: true, actor: who });
        return send(res, r.duplicate ? 200 : 201, r);
      }
      throw new HttpError(404, "not found");
    } catch (e) {
      const err = e as Error;
      const status = e instanceof HttpError ? e.status
        : e instanceof AuthorityError ? 403
        : e instanceof NotFound ? 404
        : e instanceof Conflict ? 409
        : e instanceof DigestMismatch ? 422
        : e instanceof TooLarge ? 413
        : e instanceof StorageExhausted ? 507
        : e instanceof StoreUnavailable ? 503
        : 500;
      if (status >= 500) log("error", { path: p, error: err.message });
      if (!res.headersSent) send(res, status, { error: err.message });
      else res.destroy();
    }
  });
}
