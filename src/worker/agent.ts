// Boundry CI worker agent: authenticates, registers capabilities, leases jobs, maintains leases,
// executes through the OCI executor, streams logs, uploads artifacts, and reports results.
// The worker owns no job state: everything it learns comes from, and is reported to, the control plane.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, createReadStream, createWriteStream, statSync, mkdirSync } from "node:fs";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { join } from "node:path";
import { hostname } from "node:os";
import { OciExecutor, safeJoin } from "./executor.ts";
import type { LeaseGrant, AttemptResult } from "../control/core.ts";

export interface AgentOptions {
  controlUrl: string;
  token: string;
  capabilities: string[];
  workRoot: string;
  executor?: OciExecutor;
  pollMs?: number;
  log?: (msg: string, f?: Record<string, unknown>) => void;
}

export class WorkerAgent {
  readonly o: AgentOptions;
  readonly exec: OciExecutor;
  #stopped = false;
  #log: NonNullable<AgentOptions["log"]>;

  constructor(o: AgentOptions) {
    this.o = o;
    this.exec = o.executor ?? new OciExecutor();
    this.#log = o.log ?? (() => {});
  }

  async #call(method: string, path: string, body?: unknown, retries = 5): Promise<{ status: number; json: any }> {
    let delay = 250;
    for (let i = 0; ; i++) {
      try {
        const res = await fetch(this.o.controlUrl + path, {
          method,
          headers: { authorization: `Bearer ${this.o.token}`, "content-type": "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(30_000),
        });
        const text = await res.text();
        if (res.status >= 500 && i < retries) throw new Error(`HTTP ${res.status}`);
        return { status: res.status, json: text ? JSON.parse(text) : null };
      } catch (e) {
        if (i >= retries) throw e;
        await sleep(delay); delay = Math.min(delay * 2, 5_000);
      }
    }
  }

  async register(): Promise<string[]> {
    const r = await this.#call("POST", "/v1/worker/register", { capabilities: this.o.capabilities, resources: { revision: process.env.BCI_REVISION ?? "unknown", pid: process.pid, hostname: hostname() } });
    if (r.status !== 200) throw new Error(`register failed: ${r.status} ${JSON.stringify(r.json)}`);
    return r.json.capabilities;
  }

  stop() { this.#stopped = true; }

  /** Lease and run jobs until stop() is called; a job in progress always finishes (graceful drain). */
  async runForever(): Promise<void> {
    await this.register();
    let lastRegister = Date.now();
    while (!this.#stopped) {
      const did = await this.runOnce().catch((e) => { this.#log("worker loop error", { error: String(e.message) }); return false; });
      // Re-register periodically: it refreshes the worker's liveness record even when idle.
      if (Date.now() - lastRegister > 30_000) { await this.register().catch(() => {}); lastRegister = Date.now(); }
      if (!did && !this.#stopped) await sleep(this.o.pollMs ?? 2_000);
    }
    this.#log("worker drained");
  }

  /** Lease and execute at most one job. Returns true if a job was processed. */
  async runOnce(): Promise<boolean> {
    const r = await this.#call("POST", "/v1/worker/lease", {});
    if (r.status === 204) return false;
    if (r.status !== 200) throw new Error(`lease failed: ${r.status} ${JSON.stringify(r.json)}`);
    await this.execute(r.json as LeaseGrant);
    return true;
  }

  async execute(g: LeaseGrant): Promise<void> {
    const abort = new AbortController();
    let leaseLost = false;
    const st = await this.#call("POST", `/v1/attempts/${encodeURIComponent(g.attemptId)}/start`, { leaseId: g.leaseId });
    if (!st.json?.ok) return;

    const hbEvery = Math.max(500, Math.floor(g.leaseMs / 3));
    const hb = setInterval(async () => {
      try {
        const h = await this.#call("POST", `/v1/attempts/${encodeURIComponent(g.attemptId)}/heartbeat`, { leaseId: g.leaseId }, 1);
        if (!h.json?.ok) { leaseLost = true; abort.abort(); } else if (h.json.cancel) abort.abort();
      } catch { /* transient: lease expiry on the control plane is the authority */ }
    }, hbEvery);

    const logs = new LogStreamer(async (seq, data) => {
      await this.#call("POST", `/v1/attempts/${encodeURIComponent(g.attemptId)}/logs`, { seq, data });
    }, Object.values(g.secrets));

    const workspace = mkdtempSync(join(this.o.workRoot, "ws-"));
    let result: AttemptResult;
    try {
      logs.write(`::boundry-ci:: attempt ${g.attemptId} job ${g.job.key} image ${g.job.image} worker-revision ${process.env.BCI_REVISION ?? "unknown"}\n`);
      logs.write(`::boundry-ci:: source ${g.repository}@${g.sha} definition ${g.provenance.sourceDigest} plan ${g.provenance.planDigest}\n`);
      if (g.checkout) await checkout(g, workspace);
      else await run("chmod", ["-R", "a+rwX", workspace]); // internal canary: empty workspace, no source
      await this.#fetchInputs(g, workspace, logs);
      const ex = await this.exec.run({ job: g.job, workspace, repository: g.repository, trusted: g.trusted, secrets: g.secrets, onOutput: (t) => logs.write(t), signal: abort.signal });
      let artifacts: AttemptResult["artifacts"] = [];
      let outcome: AttemptResult["outcome"] = ex.cancelled ? "cancelled" : ex.exitCode === 0 ? "succeeded" : "failed";
      let reason = ex.reason;
      if (outcome === "succeeded") {
        try { artifacts = await this.#uploadArtifacts(g, workspace, logs, false); }
        catch (e) { outcome = "failed"; reason = `artifact upload failed: ${(e as Error).message}`; }
      } else if (outcome === "failed") {
        // Artifacts declared "keep even on failure" (e.g. test results) are exactly what explains a failure.
        try { artifacts = await this.#uploadArtifacts(g, workspace, logs, true); } catch (e) { logs.write(`::boundry-ci:: could not keep failure artifacts: ${(e as Error).message}\n`); }
      }
      logs.write(`::boundry-ci:: ${outcome}${reason ? ` (${reason})` : ""}\n`);
      await logs.flush();
      result = { outcome, exitCode: ex.exitCode, reason, timedOut: ex.timedOut, logChunks: logs.seq, artifacts };
    } catch (e) {
      logs.write(`::boundry-ci:: infrastructure error: ${(e as Error).message}\n`);
      await logs.flush().catch(() => {});
      result = { outcome: "failed", exitCode: null, reason: `infrastructure: ${(e as Error).message}`, logChunks: logs.seq, artifacts: [] };
    } finally {
      clearInterval(hb);
      await this.exec.cleanup(workspace);
    }
    if (leaseLost) { this.#log("lease lost; result discarded by authority", { attempt: g.attemptId }); }
    // Idempotent: safe to retry on transport failure.
    await this.#call("POST", `/v1/attempts/${encodeURIComponent(g.attemptId)}/complete`, { leaseId: g.leaseId, result }, 10);
  }

  async #fetchInputs(g: LeaseGrant, ws: string, logs: LogStreamer): Promise<void> {
    if (!g.inputs?.length) return;
    mkdirSync(join(ws, "boundry-in"), { recursive: true });
    for (const inp of g.inputs) {
      if (!/^[A-Za-z0-9._-]+$/.test(inp.name)) throw new Error(`invalid input name ${inp.name}`);
      const res = await fetch(`${this.o.controlUrl}/v1/attempts/${encodeURIComponent(g.attemptId)}/inputs/${encodeURIComponent(inp.name)}`, { headers: { authorization: `Bearer ${this.o.token}`, "x-lease-id": g.leaseId } });
      if (!res.ok || !res.body) throw new Error(`input ${inp.name}: HTTP ${res.status}`);
      const dest = join(ws, "boundry-in", inp.name);
      await pipeline(Readable.fromWeb(res.body as any), createWriteStream(dest, { mode: 0o444 }));
      const digest = await sha256File(dest);
      if (digest !== inp.digest || statSync(dest).size !== inp.size) throw new Error(`input ${inp.name} failed verification (got sha256:${digest})`);
      logs.write(`::boundry-ci:: input ${inp.name} sha256:${digest} from ${inp.fromJob} (${inp.fromAttempt}) verified\n`);
    }
    await run("chmod", ["-R", "a+rwX", ws]);
  }

  async #uploadArtifacts(g: LeaseGrant, ws: string, logs: LogStreamer, onlyAlways: boolean): Promise<NonNullable<AttemptResult["artifacts"]>> {
    const out: NonNullable<AttemptResult["artifacts"]> = [];
    for (const a of g.job.artifacts) {
      if (onlyAlways && !a.always) continue;
      const p = safeJoin(ws, a.path);
      if (!p) throw new Error(`artifact path escapes workspace: ${a.path}`);
      let s;
      try { s = statSync(p); } catch { if (onlyAlways) continue; throw new Error(`declared artifact missing: ${a.path}`); }
      if (!s.isFile()) throw new Error(`artifact must be a regular file: ${a.path}`);
      const digest = await sha256File(p);
      const res = await fetch(`${this.o.controlUrl}/v1/artifacts/sha256/${digest}`, {
        method: "PUT",
        headers: { authorization: `Bearer ${this.o.token}`, "content-length": String(s.size), "content-type": "application/octet-stream" },
        body: createReadStream(p) as any,
        // @ts-ignore Node fetch streaming upload
        duplex: "half",
      });
      if (res.status !== 200 && res.status !== 201) throw new Error(`upload ${a.name}: HTTP ${res.status} ${await res.text()}`);
      logs.write(`::boundry-ci:: artifact ${a.name} sha256:${digest} (${s.size} bytes)\n`);
      out.push({ name: a.name, digest, size: s.size });
    }
    return out;
  }
}

/** Buffers output into ≤64 KiB chunks with secret masking; chunks are numbered for idempotent append. */
export class LogStreamer {
  seq = 0;
  #buf = "";
  #pending: Promise<void> = Promise.resolve();
  readonly #send: (seq: number, data: string) => Promise<void>;
  readonly #secrets: string[];
  #timer: NodeJS.Timeout | null = null;
  constructor(send: (seq: number, data: string) => Promise<void>, secrets: string[]) {
    this.#send = send;
    this.#secrets = secrets.filter((s) => s.length >= 4).sort((a, b) => b.length - a.length);
  }
  write(text: string) {
    this.#buf += text;
    if (this.#buf.length >= 64 * 1024) this.#drain();
    else if (!this.#timer) this.#timer = setTimeout(() => this.#drain(), 1_000);
  }
  #mask(s: string) { for (const v of this.#secrets) s = s.split(v).join("***"); return s; }
  #drain() {
    if (this.#timer) { clearTimeout(this.#timer); this.#timer = null; }
    while (this.#buf.length) {
      // Keep chunks bounded and do not split a line containing a secret across chunks where avoidable.
      let cut = Math.min(this.#buf.length, 64 * 1024);
      const nl = this.#buf.lastIndexOf("\n", cut - 1);
      if (cut < this.#buf.length && nl > 0) cut = nl + 1;
      const data = this.#mask(this.#buf.slice(0, cut));
      this.#buf = this.#buf.slice(cut);
      const seq = this.seq++;
      this.#pending = this.#pending.then(() => this.#send(seq, data));
    }
  }
  async flush() { this.#drain(); await this.#pending; }
}

async function checkout(g: LeaseGrant, ws: string): Promise<void> {
  const git = (args: string[]) => run("git", ["-C", ws, ...args]);
  await git(["init", "-q"]);
  const auth = g.checkout.header ? ["-c", `http.extraHeader=${g.checkout.header}`] : [];
  await git([...auth, "fetch", "-q", "--depth", "1", g.checkout.url, g.sha]);
  await git(["checkout", "-q", "--detach", "FETCH_HEAD"]);
  await git(["config", "--unset-all", "http.extraHeader"]).catch(() => {});
  const head = (await run("git", ["-C", ws, "rev-parse", "HEAD"])).trim();
  if (head !== g.sha) throw new Error(`checkout mismatch: wanted ${g.sha}, got ${head}`);
  rmSync(join(ws, ".git"), { recursive: true, force: true }); // jobs get source, not repository credentials/config
  await run("chmod", ["-R", "a+rwX", ws]);
}

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((res, rej) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (c) => (c === 0 ? res(out) : rej(new Error(`${cmd} ${args[2] ?? ""} failed: ${err.trim().split("\n").pop()}`))));
  });
}

async function sha256File(p: string): Promise<string> {
  const h = createHash("sha256");
  for await (const c of createReadStream(p)) h.update(c as Buffer);
  return h.digest("hex");
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
