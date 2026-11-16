// GitHub App integration against a LOCAL STAND-IN for api.github.com (simulated, not GitHub).
// What is real: the adapter's HTTP requests, RS256 App JWT signing (verified with the public key),
// permission scoping per token, token caching, webhook HMAC verification and event normalization,
// and the control plane's status outbox. What is not: GitHub's own authorization decisions.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { generateKeyPairSync, createVerify, createHmac } from "node:crypto";
import { GithubAdapter, verifyWebhookSignature, normalizeGithubEvent } from "../src/scm/github.ts";
import { FeltDbProcess, MapSecrets, sha } from "./helpers.ts";
import { ControlPlane, C } from "../src/control/core.ts";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
const APP_ID = "424242", INSTALLATION = "777";

interface Seen { method: string; path: string; auth: string; body: any }
let server: Server, url: string;
const seen: Seen[] = [];
let statusMode: 201 | 403 | 500 = 201;
const statuses: { sha: string; context: string; state: string }[] = [];
let tokenCounter = 0;

before(async () => {
  server = createServer(async (req, res) => {
    let raw = ""; for await (const c of req) raw += c;
    const body = raw ? JSON.parse(raw) : null;
    const auth = String(req.headers.authorization ?? "");
    seen.push({ method: req.method!, path: req.url!, auth, body });
    const send = (code: number, o: unknown) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
    if (req.url === `/app/installations/${INSTALLATION}/access_tokens` && req.method === "POST") {
      const jwt = auth.replace(/^Bearer /, "");
      const [h, p, sig] = jwt.split(".");
      const ok = createVerify("RSA-SHA256").update(`${h}.${p}`).verify(publicKey, Buffer.from(sig, "base64url"));
      const claims = JSON.parse(Buffer.from(p, "base64url").toString());
      if (!ok || claims.iss !== APP_ID || claims.exp - claims.iat > 600) return send(401, { message: "Bad credentials" });
      return send(201, { token: `ghs_test_${++tokenCounter}`, expires_at: new Date(Date.now() + 3600_000).toISOString(), permissions: body.permissions });
    }
    if (!auth.startsWith("Bearer ghs_test_")) return send(401, { message: "Requires authentication" });
    const st = /^\/repos\/([^/]+\/[^/]+)\/statuses\/([0-9a-f]{40})$/.exec(req.url!);
    if (st && req.method === "POST") {
      if (statusMode !== 201) return send(statusMode, { message: statusMode === 403 ? "Resource not accessible by integration" : "boom" });
      statuses.push({ sha: st[2], context: body.context, state: body.state });
      return send(201, { id: statuses.length });
    }
    if (/\/contents\/\.boundry\/ci\.yaml\?ref=/.test(req.url!)) { res.writeHead(200); return res.end("version: 1\non: {push: {}}\njobs: { j: { image: x, steps: [{run: \"true\"}] } }\n"); }
    if (/\/commits\/main$/.test(req.url!)) { res.writeHead(200); return res.end(sha(9)); }
    send(404, { message: "Not Found" });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(server.address() as any).port}`;
});
after(() => server.close());

const adapter = () => new GithubAdapter({ apiUrl: url, appId: APP_ID, privateKeyPem: privateKey, installations: { acme: INSTALLATION } });

test("G1 App JWT is RS256-signed and accepted; control token requests exactly contents:read, statuses:write, metadata:read", async () => {
  seen.length = 0;
  const g = adapter();
  assert.equal(await g.resolveBranch("acme/app", "main"), sha(9));
  const tokenReqs = seen.filter((s) => s.path.endsWith("/access_tokens"));
  assert.equal(tokenReqs.length, 1);
  assert.deepEqual(tokenReqs[0].body.permissions, { contents: "read", statuses: "write", metadata: "read" });
  await g.readFile("acme/app", sha(9), ".boundry/ci.yaml");
  assert.equal(seen.filter((s) => s.path.endsWith("/access_tokens")).length, 1, "installation token cached");
});

test("G2 worker checkout token is separate and read-only (contents:read, metadata:read); never the status-writing token", async () => {
  seen.length = 0;
  const g = adapter();
  await g.resolveBranch("acme/app", "main");
  const co = await g.checkoutAuth("acme/app");
  const reqs = seen.filter((s) => s.path.endsWith("/access_tokens")).map((s) => s.body.permissions);
  assert.deepEqual(reqs, [{ contents: "read", statuses: "write", metadata: "read" }, { contents: "read", metadata: "read" }]);
  const coToken = Buffer.from(co.header!.split(" ").pop()!, "base64").toString().split(":")[1];
  const controlToken = seen.find((s) => s.path.includes("/commits/"))!.auth.replace("Bearer ", "");
  assert.notEqual(coToken, controlToken);
});

test("G3 an owner with no installation is refused (no fallback to broader credentials)", async () => {
  await assert.rejects(adapter().readFile("other/repo", sha(1), ".boundry/ci.yaml"), /no GitHub App installation configured for other/);
});

test("G4 HTTP 403 and 5xx are never recorded as delivered; delivery succeeds after access is granted, final state wins", async () => {
  const db = new FeltDbProcess(); await db.start();
  try {
    const cp = new ControlPlane({ store: db.store(), scm: adapter(), secrets: new MapSecrets({}) });
    await cp.intake({ provider: "github", deliveryId: "g4", kind: "push", repository: "acme/app", ref: "refs/heads/main", sha: sha(9), trusted: true });
    statusMode = 403;
    assert.equal(await cp.deliverStatuses(), 0);
    let ob = await cp.store.query(C.outbox, [], { limit: 50 });
    assert.ok(ob.every((o: any) => o.delivered === false && o.attempts === 1 && /HTTP 403/.test(o.lastError)), JSON.stringify(ob));
    statusMode = 500;
    await cp.deliverStatuses();
    ob = await cp.store.query(C.outbox, [], { limit: 50 });
    assert.ok(ob.every((o: any) => o.delivered === false && o.attempts === 2));
    // The job finishes while GitHub is still refusing; then access is fixed.
    const tok = await cp.createWorker("g4w", ["linux-small"]);
    const w = await cp.authenticateWorker(tok); await cp.registerWorker(w, ["linux-small"], {});
    const g = (await cp.lease((await cp.store.get(C.workers, "g4w")) as any))!;
    await cp.start("g4w", g.attemptId, g.leaseId);
    await cp.complete("g4w", g.attemptId, g.leaseId, { outcome: "succeeded", exitCode: 0 });
    statusMode = 201;
    await cp.deliverStatuses();
    const last = new Map(statuses.filter((s) => s.sha === sha(9)).map((s) => [s.context, s.state]));
    assert.equal(last.get("boundry-ci"), "success");
    assert.equal(last.get("boundry-ci/j"), "success");
    assert.ok(!statuses.some((s) => s.sha === sha(9) && s.state === "pending"), "stale pending never delivered after the final state");
    ob = await cp.store.query(C.outbox, [{ field: "delivered", eq: false }], { limit: 50 });
    assert.equal(ob.length, 0);
  } finally { await db.stop(); }
});

test("G5 webhook signatures: exact HMAC-SHA256 over raw bytes; tampering, wrong secret, missing header rejected", () => {
  const body = Buffer.from(JSON.stringify({ ref: "refs/heads/main" }));
  const good = "sha256=" + createHmac("sha256", "s3cret").update(body).digest("hex");
  assert.equal(verifyWebhookSignature("s3cret", body, good), true);
  assert.equal(verifyWebhookSignature("s3cret", Buffer.from(body.toString().replace("main", "evil")), good), false);
  assert.equal(verifyWebhookSignature("other", body, good), false);
  assert.equal(verifyWebhookSignature("s3cret", body, undefined), false);
  assert.equal(verifyWebhookSignature("s3cret", body, good.replace("sha256=", "sha1=")), false);
  assert.equal(verifyWebhookSignature("s3cret", body, good.slice(0, -2)), false);
});

test("G6 event normalization and trust: fork PRs untrusted, same-repo PRs trusted, deletes ignored, tags and releases typed", () => {
  const repo = { full_name: "acme/app" };
  const pr = (head: string, action = "opened") => normalizeGithubEvent("pull_request", "d", { action, repository: repo, pull_request: { number: 5, head: { sha: sha(1), repo: { full_name: head } }, base: { ref: "main" } } });
  assert.equal(pr("mallory/app")!.trusted, false);
  assert.equal(pr("acme/app")!.trusted, true);
  assert.equal(pr("acme/app", "closed"), null);
  assert.equal(normalizeGithubEvent("push", "d", { ref: "refs/heads/x", after: "0".repeat(40), deleted: true, repository: repo }), null);
  assert.equal(normalizeGithubEvent("push", "d", { ref: "refs/tags/v1", after: sha(2), repository: repo })!.kind, "tag");
  assert.equal(normalizeGithubEvent("release", "d", { action: "published", release: { tag_name: "v1", target_commitish: sha(3) }, repository: repo })!.kind, "release");
  assert.equal(normalizeGithubEvent("issues", "d", { repository: repo }), null);
  assert.equal(normalizeGithubEvent("push", "", { ref: "refs/heads/main", after: sha(2), repository: repo }), null, "no delivery id, no event");
});
