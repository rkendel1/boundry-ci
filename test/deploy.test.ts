// Deployment acceptance tests: real Docker Compose project, real FeltDB (production mode, auth on,
// dedicated uid, read-only rootfs), real control-plane images, a real worker process executing a
// real canary job. Runs on whatever host executes the tests — it is NOT the Hetzner host.
// Requires images (see test/README.md): boundry-ci:test-a, boundry-ci:test-b, bci-test-feltdb:local,
// and the digest-pinned canary image. Skips with a reason if any is missing; never fakes them.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, readFileSync, readlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Deployer, type Layout, type ReleaseManifest } from "../src/deploy/lifecycle.ts";
import { FeltStore } from "../src/store/feltdb.ts";
import { ControlPlane, C, type JobRec, type RunRec, type WorkerRec } from "../src/control/core.ts";
import { FakeScm, MapSecrets } from "./helpers.ts";

const IDENTITY = process.env.BCI_IDENTITY_SCRIPT ?? "/home/user/appboundry/deploy/boundry/image-identity.mjs";
const CANARY = process.env.BCI_CANARY_IMAGE ?? "mirror.gcr.io/library/node@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee";
const IMAGES = { a: "boundry-ci:test-a", b: "boundry-ci:test-b", feltdb: "bci-test-feltdb:local", broken: "boundry-ci:test-broken" };
const REV = { a: "a".repeat(40), b: "b".repeat(40), broken: "c".repeat(40) };

const have = (ref: string) => spawnSync("docker", ["image", "inspect", ref], { stdio: "ignore" }).status === 0;
const missing = [IMAGES.a, IMAGES.b, IMAGES.feltdb, CANARY].filter((r) => !have(r));
const skip = missing.length ? `missing images: ${missing.join(", ")}` : existsSync(IDENTITY) ? false : `missing ${IDENTITY}`;

const configDigest = (ref: string) => JSON.parse(execFileSync("node", [IDENTITY, "identity", ref], { encoding: "utf8" })).configDigest as string;

let base: string, L: Layout, d: Deployer;
const n = Math.floor(Math.random() * 200) + 20;

function bundle(id: string, control: string, revision: string, settings: Partial<ReleaseManifest["settings"]> = {}): string {
  const dir = join(base, "bundles", id);
  mkdirSync(dir, { recursive: true });
  const m: ReleaseManifest = {
    releaseId: id, revision,
    images: { control: { ref: control, configDigest: configDigest(control) }, feltdb: { ref: IMAGES.feltdb, configDigest: configDigest(IMAGES.feltdb) }, canary: { ref: CANARY, configDigest: configDigest(CANARY) } },
    settings: { workerCapabilities: "linux-small", ociCli: "docker", allowRootfulExecutor: true, casMinFreeBytes: 0, leaseMs: 15_000, requireGithubApp: false, ...settings },
  };
  writeFileSync(join(dir, "release.json"), JSON.stringify(m, null, 2));
  copyFileSync("deploy/hetzner/compose.yml", join(dir, "compose.yml"));
  return dir;
}

const containerIds = () => execFileSync("docker", ["ps", "-q", "--filter", `label=com.docker.compose.project=${L.project}`], { encoding: "utf8" }).trim().split("\n").filter(Boolean).sort();
const operator = () => readFileSync(join(L.etc, "deployer", "operator-token"), "utf8").trim();
const version = async () => (await (await fetch(`http://127.0.0.1:${L.portControl}/v1/diag/version`, { headers: { authorization: `Bearer ${operator()}` } })).json() as any).revision;
const events = () => d.journal.read().map((e) => e.event);

before(async () => {
  if (skip) return;
  if (!have(IMAGES.broken)) {
    // A control image that starts a container which never serves: the install must fail and roll back.
    const ctx = mkdtempSync(join(tmpdir(), "broken-"));
    writeFileSync(join(ctx, "Dockerfile"), `FROM ${IMAGES.b}\nENV BCI_REVISION=${REV.broken}\nCMD ["no-such-command"]\n`);
    execFileSync("docker", ["build", "-q", "-t", IMAGES.broken, ctx]);
  }
  base = mkdtempSync(join(tmpdir(), "bci-deploy-"));
  L = {
    root: join(base, "opt"), etc: join(base, "etc"), var: join(base, "var"), project: `bcitest${process.pid}`,
    portControl: 22000 + n, portFeltdb: 23000 + n, subnet: `10.231.${n}.0/24`, identityScript: IDENTITY,
    workerDriver: "process", workerUnit: "unused", workerId: "test-worker", verifyTimeoutMs: 45_000, drainTimeoutMs: 30_000,
  };
  d = new Deployer(L);
});

after(async () => {
  if (skip || !d) return;
  await d.stopWorkerProcess();
  spawnSync("docker", ["compose", "-p", L.project, "down", "-v", "--remove-orphans"], { stdio: "ignore" });
  spawnSync("docker", ["network", "rm", L.project], { stdio: "ignore" });
});

test("D0 preflight refuses a release whose image does not match its pinned digest — nothing changes", { skip }, async () => {
  const dir = bundle("bad-pin", IMAGES.a, REV.a);
  const m = JSON.parse(readFileSync(join(dir, "release.json"), "utf8"));
  m.images.control.configDigest = "sha256:" + "0".repeat(64);
  writeFileSync(join(dir, "release.json"), JSON.stringify(m));
  await d.init(m); // creates secrets layout (idempotent)
  const r = await d.apply(dir);
  assert.equal(r.event, "refused");
  assert.match(r.problems!.join(" "), /config digest/);
  assert.equal(d.pointer("active"), null);
  assert.equal(containerIds().length, 0);
});

test("D0b preflight refuses a rootful Docker executor unless explicitly allowed", { skip }, async () => {
  const dir = bundle("rootful", IMAGES.a, REV.a, { allowRootfulExecutor: false });
  const r = await d.apply(dir);
  assert.equal(r.event, "refused");
  assert.match(r.problems!.join(" "), /rootful Docker/);
});

test("D1 first install: committed only after independent health (FeltDB, control, storage, worker canary)", { skip, timeout: 240_000 }, async () => {
  const dir = bundle("r-a", IMAGES.a, REV.a);
  const init = await d.init(JSON.parse(readFileSync(join(dir, "release.json"), "utf8"))); // idempotent
  assert.ok(Object.values(init).every((v) => !v.startsWith("MISSING")), JSON.stringify(init));
  const r = await d.apply(dir);
  assert.equal(r.event, "committed", JSON.stringify(r.checks, null, 2));
  const names = r.checks!.map((c) => `${c.ok ? "ok" : "FAIL"} ${c.name}`);
  assert.equal(r.checks!.length, 6, names.join("\n"));
  assert.ok(r.checks!.every((c) => c.ok), names.join("\n"));
  assert.equal(d.pointer("current"), "r-a");
  assert.equal(await version(), REV.a);
  // Secrets never appear in the journal; only fingerprints.
  const journal = readFileSync(join(L.var, "deployments.jsonl"), "utf8");
  for (const s of [readFileSync(join(L.etc, "deployer", "operator-token"), "utf8").trim(), readFileSync(join(L.etc, "secrets", "control", "feltdb-token"), "utf8").trim()]) assert.ok(!journal.includes(s));
});

test("D2 re-running the same release is idempotent: verified, nothing recreated", { skip, timeout: 240_000 }, async () => {
  const before = containerIds();
  const r = await d.apply(bundle("r-a", IMAGES.a, REV.a));
  assert.equal(r.event, "noop_verified");
  assert.deepEqual(containerIds(), before);
});

test("D3 upgrade preserves queued jobs, active leases, attempts and status outbox across restarts", { skip, timeout: 300_000 }, async () => {
  const store = new FeltStore({ url: `http://127.0.0.1:${L.portFeltdb}`, token: readFileSync(join(L.etc, "secrets", "control", "feltdb-token"), "utf8").trim() });
  const scm = new FakeScm();
  scm.files.set(`acme/app@${"1".repeat(40)}`, `version: 1\non: {push: {}}\njobs:\n  arm: { image: x, requires: [linux-arm64], steps: [{run: "true"}] }\n  held: { image: x, requires: [linux-build], steps: [{run: "true"}] }\n`);
  const cp = new ControlPlane({ store, scm, secrets: new MapSecrets({}), leaseMs: 120_000 });
  const { runId } = await cp.intake({ provider: "github", deliveryId: "seed-1", kind: "push", repository: "acme/app", ref: "refs/heads/main", sha: "1".repeat(40), trusted: true });
  const tok = await cp.createWorker("seed-holder", ["linux-build"]);
  const holder = await cp.authenticateWorker(tok);
  await cp.registerWorker(holder, ["linux-build"], {});
  const g = (await cp.lease((await store.get<WorkerRec>(C.workers, "seed-holder"))!))!;
  await cp.start("seed-holder", g.attemptId, g.leaseId);
  const snapshot = async () => ({
    run: await store.get<RunRec>(C.runs, runId!),
    jobs: (await store.query<JobRec>(C.jobs, [{ field: "runId", eq: runId! }], { limit: 10 })).map((j) => [j.key, j.state, j.attemptId, j.leaseId]),
    attempt: await store.get(C.attempts, g.attemptId),
    outbox: (await store.query(C.outbox, [{ field: "runId", eq: runId! }], { limit: 50 })).map((o: any) => [o.id, o.context, o.state, o.delivered]).sort(),
  });
  const before = await snapshot();

  const r = await d.apply(bundle("r-b", IMAGES.b, REV.b));
  assert.equal(r.event, "committed", JSON.stringify(r.checks, null, 2));
  assert.equal(await version(), REV.b);

  const afterSnap = await snapshot();
  assert.deepEqual(afterSnap.jobs, before.jobs, "queued job and active lease unchanged");
  assert.deepEqual(afterSnap.attempt, before.attempt, "attempt evidence unchanged");
  for (const o of before.outbox) assert.ok(afterSnap.outbox.some((x) => x[0] === o[0]), `outbox entry ${o[0]} survived`);
  // The lease held across the restart is still honoured by the NEW control plane over HTTP.
  const hb = await fetch(`http://127.0.0.1:${L.portControl}/v1/attempts/${g.attemptId}/heartbeat`, { method: "POST", headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" }, body: JSON.stringify({ leaseId: g.leaseId }) });
  assert.equal(((await hb.json()) as any).ok, true);
  const done = await fetch(`http://127.0.0.1:${L.portControl}/v1/attempts/${g.attemptId}/complete`, { method: "POST", headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" }, body: JSON.stringify({ leaseId: g.leaseId, result: { outcome: "succeeded", exitCode: 0 } }) });
  assert.equal(((await done.json()) as any).jobState, "succeeded");
  assert.equal((await store.query<JobRec>(C.jobs, [{ field: "runId", eq: runId! }, { field: "key", eq: "arm" }], { limit: 1 }))[0].state, "queued");
});

test("D4 install failure (container never serves) leaves the previous version running and committed", { skip, timeout: 300_000 }, async () => {
  const r = await d.apply(bundle("r-broken", IMAGES.broken, REV.broken));
  assert.equal(r.event, "rolled_back", JSON.stringify(r, null, 2));
  assert.equal(r.restored, "r-b");
  assert.equal(d.pointer("current"), "r-b");
  assert.equal(d.pointer("active"), "r-b");
  assert.equal(await version(), REV.b);
  const ev = events();
  assert.equal(ev.at(-1), "rolled_back");
  assert.equal(ev.at(-2), "failed");
});

test("D5 a failed health check blocks success even when every container starts (worker cannot run the canary)", { skip, timeout: 300_000 }, async () => {
  // Same healthy image, but this release grants the worker no capability the canary needs.
  const r = await d.apply(bundle("r-b-nocap", IMAGES.b, REV.b, { workerCapabilities: "linux-build" }));
  assert.equal(r.event, "rolled_back");
  const failed = r.checks!.filter((c) => !c.ok).map((c) => c.name);
  assert.deepEqual(failed, ["canary job leased, executed in isolation, artifact stored, by this release's worker"]);
  assert.equal(d.pointer("current"), "r-b");
});

test("D6 artifact storage that cannot accept writes fails verification and rolls back", { skip, timeout: 300_000 }, async () => {
  const r = await d.apply(bundle("r-b-nostore", IMAGES.b, REV.b, { casMinFreeBytes: Number.MAX_SAFE_INTEGER }));
  assert.equal(r.event, "rolled_back");
  const probe = r.checks!.find((c) => c.name.startsWith("FeltDB write/read/delete"))!;
  assert.equal(probe.ok, false);
  assert.match(probe.detail, /507|reserve/);
  // Rollback restores the previous CONFIGURATION, not just the image.
  const env = readFileSync(join(L.root, "active", "release.env"), "utf8");
  assert.match(env, /BCI_CAS_MIN_FREE_BYTES=0\n/);
});

test("D7 manual rollback restores the previous committed version and configuration", { skip, timeout: 300_000 }, async () => {
  const r = await d.rollback();
  assert.equal(r.event, "committed", JSON.stringify(r.checks, null, 2));
  assert.equal(r.releaseId, "r-a");
  assert.equal(d.pointer("current"), "r-a");
  assert.equal(await version(), REV.a);
  assert.equal(readlinkSync(join(L.root, "active")), join("releases", "r-a"));
});

test("D8 concurrent deployments are refused; the journal is intact and hash-chained", { skip, timeout: 300_000 }, async () => {
  const p1 = d.apply(bundle("r-a", IMAGES.a, REV.a));
  await new Promise((r) => setTimeout(r, 300));
  await assert.rejects(new Deployer(L).apply(bundle("r-b", IMAGES.b, REV.b)), /another deployment is in progress/);
  assert.equal((await p1).event, "noop_verified");
  assert.doesNotThrow(() => d.journal.read());
  const status = await d.status();
  assert.equal(status.journalIntegrity, "ok");
  assert.equal(status.current, "r-a");
  assert.ok(!JSON.stringify(status).includes(operator()), "status output contains no operator token");
});

test("D9 backup → later writes → restore returns exactly the backed-up state, verified healthy; old data moved aside", { skip, timeout: 400_000 }, async () => {
  const token = readFileSync(join(L.etc, "secrets", "control", "feltdb-token"), "utf8").trim();
  const store = new FeltStore({ url: `http://127.0.0.1:${L.portFeltdb}`, token });
  const scm = new FakeScm();
  const spec = `version: 1\non: {push: {}}\njobs: { j: { image: x, requires: [linux-arm64], steps: [{run: "true"}] } }\n`;
  scm.files.set(`acme/before@${"2".repeat(40)}`, spec);
  scm.files.set(`acme/after@${"3".repeat(40)}`, spec);
  const cp = new ControlPlane({ store, scm, secrets: new MapSecrets({}) });
  const before = await cp.intake({ provider: "github", deliveryId: "bk-before", kind: "push", repository: "acme/before", ref: "refs/heads/main", sha: "2".repeat(40), trusted: true });

  // The control key cannot take backups and the backup key cannot read CI state (least privilege).
  const asControl = await fetch(`http://127.0.0.1:${L.portFeltdb}/admin/backups`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: '{"output":"nope"}' });
  assert.equal(asControl.status, 403);
  const bkey = readFileSync(join(L.etc, "secrets", "backup-token"), "utf8").trim();
  assert.equal((await fetch(`http://127.0.0.1:${L.portFeltdb}/collections/ci_runs/${before.runId}`, { headers: { authorization: `Bearer ${bkey}` } })).status, 403);

  const backups = join(base, "backups");
  const b = await d.backup(backups);
  assert.ok(b.feltdbFiles > 0);
  assert.ok(b.casObjects > 0, "canary artifacts are part of the set");
  const after = await cp.intake({ provider: "github", deliveryId: "bk-after", kind: "push", repository: "acme/after", ref: "refs/heads/main", sha: "3".repeat(40), trusted: true });
  // Lose an artifact object locally; restore must bring it back, hash-verified.
  const casDir = join(L.var, "data", "cas", "sha256");
  const obj = execFileSync("find", [casDir, "-type", "f"], { encoding: "utf8" }).trim().split("\n")[0];
  const [pre, hex] = obj.split("/").slice(-2);
  execFileSync("rm", [join(casDir, pre, hex)]);

  const r = await d.restore(b.set);
  assert.equal(r.event, "restored", JSON.stringify(r, null, 2));
  assert.ok(r.checks!.every((c) => c.ok));
  assert.ok(await store.get(C.runs, before.runId!), "state from before the backup is present");
  assert.equal(await store.get(C.runs, after.runId!), null, "state written after the backup is absent");
  const restoredBytes = readFileSync(join(casDir, pre, hex));
  assert.equal(execFileSync("sha256sum", { input: restoredBytes, encoding: "utf8" }).split(" ")[0], hex);
  const last = d.journal.read().at(-1)!;
  assert.equal(last.event, "restored");
  assert.ok(existsSync(last.data.movedAside as string), "previous data was moved aside, not deleted");
  // A tampered set is refused before anything is stopped.
  writeFileSync(join(b.set, "cas-objects.txt"), "tampered\n");
  const bad = await d.restore(b.set);
  assert.equal(bad.event, "restore_failed");
  assert.equal(await version(), REV.a, "service still running after a refused restore");
});
