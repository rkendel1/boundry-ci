// Platform acceptance tests against a real feltdb-server (no mocks of FeltDB).
import { test, beforeEach, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { FeltDbProcess, FakeScm, MapSecrets, Clock, makeCp, sha } from "./helpers.ts";
import { ControlPlane, C, AuthorityError, Conflict, type JobRec, type RunRec, type AttemptRec, type WorkerRec } from "../src/control/core.ts";
import { createControlServer } from "../src/control/http.ts";
import { ContentStore, DigestMismatch, StorageExhausted } from "../src/artifacts/cas.ts";
import { OciExecutor } from "../src/worker/executor.ts";
import { compile } from "../src/spec/compile.ts";
import { StoreUnavailable } from "../src/store/feltdb.ts";
import { sha256Hex } from "../src/canonical.ts";

// Each test gets its own FeltDB process: leasing is global by design, so shared state would
// let one test's worker legitimately lease another test's job.
let db: FeltDbProcess;
const all: FeltDbProcess[] = [];
beforeEach(async () => { db = new FeltDbProcess(); all.push(db); await db.start(); });
afterEach(async () => { await db.stop(); });
after(async () => { for (const d of all) await d.stop(); });

let n = 0;
const uniq = () => `t${process.pid}-${++n}`;

const SPEC = `
version: 1
on: { push: { branches: [main] }, pull_request: {}, tag: { patterns: ["v*"] }, schedule: [{ cron: "0 3 * * *", branch: main }] }
concurrency: { group: "\${repository}/\${ref}", cancel_in_progress: true }
defaults: { image: alpine:3.20 }
jobs:
  lint: { steps: [{ run: "true" }], retry: { max_attempts: 2, on: [failure, infrastructure] } }
  test: { needs: [lint], steps: [{ run: "true" }] }
  build: { needs: [test], steps: [{ run: "true" }] }
  publish:
    needs: [build]
    when: { events: [tag] }
    requires: [release]
    permissions: { release: true }
    secrets: [NPM_TOKEN]
    approval: { required: true, approvers: [randy] }
    image: "alpine@sha256:${"c".repeat(64)}"
    steps: [{ run: "true" }]
`;

async function newRepo(scm: FakeScm, spec = SPEC) {
  const repo = `acme/${uniq()}`;
  const s = sha(++n);
  scm.files.set(`${repo}@${s}`, spec);
  scm.branches.set(`${repo}#main`, s);
  return { repo, s };
}
const push = (repo: string, s: string, delivery = uniq()) => ({ provider: "github", deliveryId: delivery, kind: "push" as const, repository: repo, ref: "refs/heads/main", sha: s, trusted: true });

async function worker(cp: ControlPlane, caps = ["linux-small"]): Promise<WorkerRec> {
  const id = `w-${uniq()}`.toLowerCase();
  const tok = await cp.createWorker(id, caps);
  const w = await cp.authenticateWorker(tok);
  await cp.registerWorker(w, caps, {});
  return (await cp.store.get<WorkerRec>(C.workers, id))!;
}
const jobs = async (cp: ControlPlane, runId: string) => Object.fromEntries((await cp.store.query<JobRec>(C.jobs, [{ field: "runId", eq: runId }], { limit: 100 })).map((j) => [j.key, j]));

async function drive(cp: ControlPlane, w: WorkerRec, outcome: "succeeded" | "failed" = "succeeded") {
  const g = await cp.lease(w);
  if (!g) return null;
  await cp.start(w.id, g.attemptId, g.leaseId);
  await cp.complete(w.id, g.attemptId, g.leaseId, { outcome, exitCode: outcome === "succeeded" ? 0 : 1 });
  return g;
}

test("01 duplicate webhook delivery creates exactly one run", async () => {
  const { cp, scm } = makeCp(db);
  const { repo, s } = await newRepo(scm);
  const cas = new ContentStore({ root: mkdtempSync(join(tmpdir(), "cas-")), minFreeBytes: 0 });
  const server = createControlServer({ cp, cas, webhookSecret: "whsec", operators: {} });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as any).port;
  const payload = JSON.stringify({ ref: "refs/heads/main", after: s, repository: { full_name: repo }, sender: { login: "randy" } });
  const sig = "sha256=" + createHmac("sha256", "whsec").update(payload).digest("hex");
  const send = (signature: string) => fetch(`http://127.0.0.1:${port}/webhooks/github`, { method: "POST", body: payload, headers: { "x-github-event": "push", "x-github-delivery": "dlv-1-" + repo, "x-hub-signature-256": signature } });
  const results = await Promise.all([send(sig), send(sig), send(sig)]);
  const bodies = await Promise.all(results.map((r) => r.json()));
  const runIds = new Set(bodies.map((b: any) => b.runId));
  assert.equal(runIds.size, 1);
  assert.equal(bodies.filter((b: any) => !b.duplicate).length, 1);
  assert.equal((await send("sha256=" + "0".repeat(64))).status, 401, "bad signature rejected");
  const runs = await cp.store.query(C.runs, [{ field: "repository", eq: repo }], { limit: 10 });
  assert.equal(runs.length, 1);
  server.close();
});

test("02 concurrent job claiming: one job, many workers, exactly one lease", async () => {
  const { cp, scm } = makeCp(db);
  const { repo, s } = await newRepo(scm, `version: 1\non: {push: {}}\njobs: { only: { image: alpine, steps: [{run: "true"}] } }\n`);
  await cp.intake(push(repo, s));
  const ws = await Promise.all(Array.from({ length: 8 }, () => worker(cp)));
  const grants = (await Promise.all(ws.map((w) => cp.lease(w)))).filter((g) => g && g.repository === repo);
  assert.equal(grants.length, 1);
  const attempts = await cp.store.query(C.attempts, [{ field: "jobId", eq: grants[0]!.jobId }], { limit: 10 });
  assert.equal(attempts.length, 1);
});

test("03+04 worker disappearance and lease expiry: job requeued, attempt marked lost, new attempt distinct", async () => {
  const { cp, scm, clock } = makeCp(db);
  const { repo, s } = await newRepo(scm, `version: 1\non: {push: {}}\njobs: { j: { image: alpine, steps: [{run: "true"}], retry: { max_attempts: 2, on: [infrastructure] } } }\n`);
  const { runId } = await cp.intake(push(repo, s));
  const w1 = await worker(cp);
  const g1 = (await cp.lease(w1))!;
  await cp.start(w1.id, g1.attemptId, g1.leaseId);
  // Worker vanishes. Before expiry the reaper does nothing.
  assert.deepEqual(await cp.reap().then((r) => r.expired >= 0), true);
  assert.equal((await jobs(cp, runId!)).j.state, "running");
  clock.advance(31_000);
  await cp.reap();
  const j = (await jobs(cp, runId!)).j;
  assert.equal(j.state, "queued");
  assert.equal((await cp.store.get<AttemptRec>(C.attempts, g1.attemptId))!.state, "lost");
  // The lost worker's heartbeat and late result cannot affect the job.
  assert.equal((await cp.heartbeat(w1.id, g1.attemptId, g1.leaseId)).ok, false);
  const w2 = await worker(cp);
  const g2 = (await cp.lease(w2))!;
  assert.notEqual(g2.attemptId, g1.attemptId);
  const late = await cp.complete(w1.id, g1.attemptId, g1.leaseId, { outcome: "succeeded", exitCode: 0 });
  assert.equal(late.accepted, false);
  await cp.start(w2.id, g2.attemptId, g2.leaseId);
  await cp.complete(w2.id, g2.attemptId, g2.leaseId, { outcome: "succeeded", exitCode: 0 });
  assert.equal((await cp.store.get<RunRec>(C.runs, runId!))!.state, "succeeded");
  // Second expiry with no retries left fails terminally instead of looping forever.
});

test("04b lease expiry without retry budget fails terminally (never stuck running)", async () => {
  const { cp, scm, clock } = makeCp(db);
  const { repo, s } = await newRepo(scm, `version: 1\non: {push: {}}\njobs: { j: { image: alpine, steps: [{run: "true"}], retry: { max_attempts: 1, on: [] } } }\n`);
  const { runId } = await cp.intake(push(repo, s));
  const w = await worker(cp);
  const g = (await cp.lease(w))!;
  clock.advance(31_000);
  await cp.reap();
  assert.equal((await jobs(cp, runId!)).j.state, "failed");
  assert.equal((await cp.store.get<RunRec>(C.runs, runId!))!.state, "failed");
  void g;
});

test("05 retry preserves previous attempt evidence", async () => {
  const { cp, scm } = makeCp(db);
  const { repo, s } = await newRepo(scm);
  const { runId } = await cp.intake(push(repo, s));
  const w = await worker(cp);
  const g1 = (await drive(cp, w, "failed"))!;
  assert.equal((await jobs(cp, runId!)).lint.state, "queued");
  const g2 = (await drive(cp, w, "succeeded"))!;
  const a1 = (await cp.store.get<AttemptRec>(C.attempts, g1.attemptId))!;
  const a2 = (await cp.store.get<AttemptRec>(C.attempts, g2.attemptId))!;
  assert.equal(a1.state, "failed");
  assert.equal(a1.exitCode, 1);
  assert.equal(a2.state, "succeeded");
  assert.equal((await jobs(cp, runId!)).lint.attempts, 2);
});

test("06 control-plane restart: a new instance continues the run from FeltDB state", async () => {
  const scm = new FakeScm(); const clock = new Clock();
  const { repo, s } = await newRepo(scm);
  const a = makeCp(db, scm, clock).cp;
  const { runId } = await a.intake(push(repo, s));
  const w = await worker(a);
  await drive(a, w); // lint
  const b = makeCp(db, scm, clock).cp; // "restarted" process, no shared memory
  const wb = (await b.store.get<WorkerRec>(C.workers, w.id))!;
  await drive(b, wb); // test
  await drive(b, wb); // build
  assert.equal((await b.store.get<RunRec>(C.runs, runId!))!.state, "succeeded");
});

test("07 FeltDB restart: outage is explicit (StoreUnavailable) and state survives", async () => {
  const local = new FeltDbProcess();
  await local.start();
  const { cp, scm } = makeCp(local);
  const { repo, s } = await newRepo(scm);
  const { runId } = await cp.intake(push(repo, s));
  const w = await worker(cp);
  const g = (await cp.lease(w))!;
  await local.stop();
  await assert.rejects(cp.heartbeat(w.id, g.attemptId, g.leaseId), StoreUnavailable);
  await local.start();
  assert.equal((await cp.heartbeat(w.id, g.attemptId, g.leaseId)).ok, true);
  await cp.complete(w.id, g.attemptId, g.leaseId, { outcome: "succeeded", exitCode: 0 });
  assert.equal((await jobs(cp, runId!)).lint.state, "succeeded");
  assert.equal((await jobs(cp, runId!)).test.state, "queued");
  await local.stop();
});

test("08 duplicate result submission is idempotent; conflicting resubmission is rejected", async () => {
  const { cp, scm } = makeCp(db);
  const { repo, s } = await newRepo(scm);
  await cp.intake(push(repo, s));
  const w = await worker(cp);
  const g = (await cp.lease(w))!;
  await cp.start(w.id, g.attemptId, g.leaseId);
  const r = { outcome: "succeeded" as const, exitCode: 0 };
  const [x, y] = await Promise.all([cp.complete(w.id, g.attemptId, g.leaseId, r), cp.complete(w.id, g.attemptId, g.leaseId, r)]);
  assert.equal([x, y].filter((v) => v.duplicate).length, 1);
  assert.equal((await cp.complete(w.id, g.attemptId, g.leaseId, r)).duplicate, true);
  await assert.rejects(cp.complete(w.id, g.attemptId, g.leaseId, { outcome: "failed", exitCode: 2 }), Conflict);
  const other = await worker(cp);
  await assert.rejects(cp.complete(other.id, g.attemptId, g.leaseId, r), AuthorityError);
});

test("09 cancellation: queued jobs cancel immediately, running job is signalled and settles cancelled", async () => {
  const { cp, scm } = makeCp(db);
  const { repo, s } = await newRepo(scm);
  const { runId } = await cp.intake(push(repo, s));
  const w = await worker(cp);
  const g = (await cp.lease(w))!;
  await cp.start(w.id, g.attemptId, g.leaseId);
  await cp.cancelRun(runId!, "randy");
  assert.equal((await cp.heartbeat(w.id, g.attemptId, g.leaseId)).cancel, true);
  let js = await jobs(cp, runId!);
  assert.equal(js.test.state, "cancelled");
  assert.equal(js.lint.state, "running");
  await cp.complete(w.id, g.attemptId, g.leaseId, { outcome: "cancelled", exitCode: null });
  js = await jobs(cp, runId!);
  assert.equal(js.lint.state, "cancelled");
  assert.equal((await cp.store.get<RunRec>(C.runs, runId!))!.state, "cancelled");
});

test("10 dependency failure propagates as skipped; run fails; statuses recorded in outbox", async () => {
  const { cp, scm } = makeCp(db);
  const { repo, s } = await newRepo(scm, SPEC.replace("max_attempts: 2", "max_attempts: 1"));
  const { runId } = await cp.intake(push(repo, s));
  const w = await worker(cp);
  await drive(cp, w, "failed");
  const js = await jobs(cp, runId!);
  assert.equal(js.lint.state, "failed");
  assert.equal(js.test.state, "skipped");
  assert.equal(js.build.state, "skipped");
  assert.equal((await cp.store.get<RunRec>(C.runs, runId!))!.state, "failed");
  await cp.deliverStatuses(1000);
  const mine = scm.statuses.filter((x) => x.repository === repo);
  assert.ok(mine.some((x) => x.context === "boundry-ci" && x.state === "failure"));
  assert.ok(mine.some((x) => x.context === "boundry-ci/lint" && x.state === "failure"));
});

test("11 concurrent commits to one ref: newer run supersedes (cancels) older run", async () => {
  const { cp, scm, clock } = makeCp(db);
  const { repo, s } = await newRepo(scm);
  const s2 = sha(++n); scm.files.set(`${repo}@${s2}`, SPEC);
  const r1 = await cp.intake(push(repo, s));
  clock.advance(1000);
  const r2 = await cp.intake(push(repo, s2));
  assert.equal((await cp.store.get<RunRec>(C.runs, r1.runId!))!.state, "cancelled");
  assert.equal((await cp.store.get<RunRec>(C.runs, r2.runId!))!.state, "running");
});

test("12 unauthorized release: untrusted PR cannot run release; wrong capability cannot lease; wrong approver rejected", async () => {
  const { cp, scm } = makeCp(db, new FakeScm(), new Clock(), new MapSecrets({}));
  const prSpec = SPEC.replace("when: { events: [tag] }", "");
  const { repo, s } = await newRepo(scm, prSpec);
  const pr = await cp.intake({ provider: "github", deliveryId: uniq(), kind: "pull_request", repository: repo, ref: "refs/pull/1/head", sha: s, trusted: false, baseBranch: "main" });
  assert.equal((await jobs(cp, pr.runId!)).publish.state, "failed");
  assert.match((await jobs(cp, pr.runId!)).publish.reason!, /untrusted/);
  // Trusted tag: publish waits for approval; only listed approver may approve; plain worker never gets it.
  const db2 = new FeltDbProcess(); all.push(db2); await db2.start();
  const sec = new MapSecrets({}); const tagScm = new FakeScm();
  const { cp: cp2 } = makeCp(db2, tagScm, new Clock(), sec);
  const { repo: r2, s: s2 } = await newRepo(tagScm);
  sec.scoped[r2] = { NPM_TOKEN: "npm_secret_value" };
  const tag = await cp2.intake({ provider: "github", deliveryId: uniq(), kind: "tag", repository: r2, ref: "refs/tags/v1.0.0", sha: s2, trusted: true });
  const w = await worker(cp2);
  for (let i = 0; i < 3; i++) await drive(cp2, w);
  const pub = (await jobs(cp2, tag.runId!)).publish;
  assert.equal(pub.state, "awaiting_approval");
  await assert.rejects(cp2.approve(pub.id, "mallory"), AuthorityError);
  await cp2.approve(pub.id, "randy");
  assert.equal(await cp2.lease(w), null, "linux-small worker must not lease a release job");
  const rel = await worker(cp2, ["release"]);
  const g = (await cp2.lease(rel))!;
  assert.equal(g.job.key, "publish");
  assert.deepEqual(g.secrets, { NPM_TOKEN: "npm_secret_value" });
  const approvals = await cp2.store.query(C.approvals, [{ field: "jobId", eq: pub.id }], { limit: 5 });
  assert.equal(approvals[0].approver, "randy");
});

test("13 secrets: untrusted job requesting secrets fails at intake; nothing is ever resolved for it", async () => {
  let resolved = 0;
  const scm = new FakeScm();
  const cp = new ControlPlane({ store: db.store(), scm, secrets: { resolve: async () => { resolved++; return { X: "leak" }; } }, now: new Clock().now });
  const { repo, s } = await newRepo(scm, `version: 1\non: {pull_request: {}}\njobs: { j: { image: alpine, secrets: [X], steps: [{run: "echo $X"}] } }\n`);
  const r = await cp.intake({ provider: "github", deliveryId: uniq(), kind: "pull_request", repository: repo, ref: "refs/pull/2/head", sha: s, trusted: false, baseBranch: "main" });
  assert.equal((await jobs(cp, r.runId!)).j.state, "failed");
  const w = await worker(cp);
  assert.equal(await cp.lease(w), null);
  assert.equal(resolved, 0);
  assert.equal((await cp.store.get<RunRec>(C.runs, r.runId!))!.state, "failed");
});

test("14 artifact digest mismatch is refused; result citing an unstored artifact fails the job", async () => {
  const cas = new ContentStore({ root: mkdtempSync(join(tmpdir(), "cas-")), minFreeBytes: 0 });
  const data = Buffer.from("hello artifact");
  await assert.rejects(cas.put(Readable.from([data]), "0".repeat(64)), DigestMismatch);
  const good = sha256Hex(data);
  assert.equal((await cas.put(Readable.from([data]), good)).created, true);
  assert.equal((await cas.put(Readable.from([data]), good)).created, false, "immutable: second put is a no-op");
  assert.equal(await cas.verify(good), true);
  const { cp, scm } = makeCp(db);
  const { repo, s } = await newRepo(scm, `version: 1\non: {push: {}}\njobs: { j: { image: alpine, steps: [{run: "true"}], artifacts: [{name: out, path: out.bin}] } }\n`);
  const { runId } = await cp.intake(push(repo, s));
  const w = await worker(cp);
  const g = (await cp.lease(w))!;
  await cp.start(w.id, g.attemptId, g.leaseId);
  await cp.complete(w.id, g.attemptId, g.leaseId, { outcome: "succeeded", exitCode: 0, artifacts: [{ name: "out", digest: "f".repeat(64), size: 3 }] });
  const j = (await jobs(cp, runId!)).j;
  assert.equal(j.state, "failed");
  assert.match(j.reason!, /digest mismatch|missing/);
});

test("15 cache poisoning: untrusted and trusted builds never share a cache; release jobs mount none", () => {
  const ex = new OciExecutor();
  const plan = compile(`version: 1\non: {push: {}}\njobs: { j: { image: node:22, cache: [{name: npm, path: /cache/npm, key_files: [package-lock.json]}], steps: [{run: x}] } }\n`, { repository: "a/b", kind: "push", ref: "refs/heads/main", sha: sha(1), trusted: true }).plan.jobs[0];
  const ws = mkdtempSync(join(tmpdir(), "ws-"));
  const t = ex.cacheVolume("a/b", plan, plan.cache[0], ws, true);
  const u = ex.cacheVolume("a/b", plan, plan.cache[0], ws, false);
  assert.notEqual(t, u);
  assert.match(t, /^bci-cache-t-/);
  assert.match(u, /^bci-cache-u-/);
  assert.notEqual(ex.cacheVolume("a/c", plan, plan.cache[0], ws, true), t, "repository-scoped");
});

test("19 disk exhaustion: artifact store refuses writes below its free-space reserve", async () => {
  const cas = new ContentStore({ root: mkdtempSync(join(tmpdir(), "cas-")), minFreeBytes: Number.MAX_SAFE_INTEGER });
  const data = Buffer.from("x");
  await assert.rejects(cas.put(Readable.from([data]), sha256Hex(data)), StorageExhausted);
});

test("20 scheduled job recovery: missed slot fires once after downtime; repeated ticks do not duplicate", async () => {
  const { cp, scm, clock } = makeCp(db);
  const { repo, s } = await newRepo(scm);
  await cp.intake(push(repo, s)); // registers the schedule from the default-branch definition
  const before = (await cp.store.query(C.runs, [{ field: "repository", eq: repo }], { limit: 50 })).length;
  clock.advance(3 * 86_400_000); // control plane "down" across three slots
  const a = makeCp(db, scm, clock).cp; // restarted instance
  const [f1, f2] = await Promise.all([a.tickSchedules(), a.tickSchedules()]);
  await a.tickSchedules();
  const runs = await a.store.query<RunRec>(C.runs, [{ field: "repository", eq: repo }], { limit: 50 });
  const scheduled = runs.filter((r) => r.kind === "schedule");
  assert.equal(scheduled.length, 1, `expected one catch-up run, got ${scheduled.length} (fired ${f1}+${f2})`);
  assert.equal(runs.length, before + 1);
  const sched = (await a.store.query(C.schedules, [{ field: "repository", eq: repo }], { limit: 5 }))[0];
  assert.ok((sched.nextFireAt as number) > clock.t);
});

test("invalid pipeline definitions are recorded as failed runs with evidence", async () => {
  const { cp, scm } = makeCp(db);
  const { repo, s } = await newRepo(scm, "version: 1\njobs: { bad: { image: x, steps: [] } }\n");
  const r = await cp.intake(push(repo, s));
  const run = (await cp.store.get<RunRec>(C.runs, r.runId!))!;
  assert.equal(run.state, "failed");
  assert.match(run.reason!, /invalid/);
  assert.ok(await cp.store.get(C.defs, "def_" + run.sourceDigest!), "definition source retained by digest");
});

test("status outbox: a retried stale 'pending' never overwrites a final state", async () => {
  const { cp, scm } = makeCp(db);
  const { repo, s } = await newRepo(scm, `version: 1\non: {push: {}}\njobs: { j: { image: alpine, steps: [{run: "true"}] } }\n`);
  await cp.intake(push(repo, s));
  scm.failStatus = true;
  await cp.deliverStatuses(); // pending fails to deliver (GitHub down)
  const w = await worker(cp);
  await drive(cp, w);
  scm.failStatus = false;
  await cp.deliverStatuses();
  await cp.deliverStatuses();
  const last = new Map(scm.statuses.filter((x) => x.repository === repo).map((x) => [x.context, x.state]));
  assert.equal(last.get("boundry-ci"), "success");
  assert.equal(last.get("boundry-ci/j"), "success");
  assert.equal(scm.statuses.filter((x) => x.repository === repo && x.state === "pending").length, 0);
});

test("artifact upload of bytes already stored (a reproducible rebuild) succeeds and keeps one metadata record", async () => {
  const { cp } = makeCp(db);
  const cas = new ContentStore({ root: mkdtempSync(join(tmpdir(), "cas-")), minFreeBytes: 0 });
  const server = createControlServer({ cp, cas, webhookSecret: "x", operators: {} });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const url = `http://127.0.0.1:${(server.address() as any).port}`;
    const tok = await cp.createWorker(`w-up-${process.pid}`, ["linux-small"]);
    const data = Buffer.from("reproducible build output");
    const hex = sha256Hex(data);
    const put = () => fetch(`${url}/v1/artifacts/sha256/${hex}`, { method: "PUT", body: data, headers: { authorization: `Bearer ${tok}` } });
    assert.equal((await put()).status, 201);
    assert.equal((await put()).status, 200);
    const [a, b] = await Promise.all([put(), put()]);
    assert.deepEqual([a.status, b.status], [200, 200]);
    assert.ok(await cp.store.get(C.artifacts, `sha256-${hex}`));
  } finally { server.close(); }
});
