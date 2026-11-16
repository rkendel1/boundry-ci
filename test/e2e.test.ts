// End-to-end vertical slice: signed webhook -> FeltDB-backed run -> lease -> worker checkout of a
// real GitHub commit -> hardened container -> durable logs + content-addressed artifacts -> statuses.
// Requires: a feltdb-server binary, a Docker-compatible daemon, network access to github.com.
// Skips (with a reason) when those are absent; it never fakes the executor.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FeltDbProcess, FakeScm, MapSecrets, Clock } from "./helpers.ts";
import { ControlPlane, C, type RunRec, type JobRec, type AttemptRec } from "../src/control/core.ts";
import { createControlServer } from "../src/control/http.ts";
import { ContentStore } from "../src/artifacts/cas.ts";
import { WorkerAgent } from "../src/worker/agent.ts";
import { OciExecutor } from "../src/worker/executor.ts";

const IMAGE = process.env.BCI_TEST_IMAGE ?? "mirror.gcr.io/library/node:22-bookworm-slim";
const REPO = process.env.BCI_TEST_REPO ?? "rkendel1/boundry-ci";
const SHA = process.env.BCI_TEST_SHA ?? "052e80c8cfcd61bc5e6c30313c792bc7e7512ab5";

const dockerOk = spawnSync("docker", ["image", "inspect", IMAGE], { stdio: "ignore" }).status === 0;
const skip = dockerOk ? false : `docker daemon or image ${IMAGE} unavailable`;

const PIPELINE = `
version: 1
name: e2e
on: { push: { branches: [main] } }
defaults: { image: ${IMAGE}, timeout_minutes: 5 }
jobs:
  check:
    resources: { cpus: 1, memory_mb: 256 }
    steps:
      - name: identity and isolation
        run: |
          id
          test "$(id -u)" != "0"
          test -f package.json && test -f src/control/core.ts
          if node -e "require('net').connect(443,'1.1.1.1').on('connect',()=>process.exit(0)).on('error',()=>process.exit(3))"; then echo "NETWORK REACHABLE"; exit 1; else echo "network: none (as declared)"; fi
          if touch /etc/x 2>/dev/null; then echo "ROOTFS WRITABLE"; exit 1; else echo "rootfs: read-only"; fi
      - name: produce artifact
        run: |
          mkdir -p out
          sha256sum package.json src/control/core.ts > out/report.txt
          cat out/report.txt
    artifacts: [{ name: report, path: out/report.txt }]
  package:
    needs: [check]
    steps: [{ run: "node -e \\"console.log('packaged on', process.version)\\"" }]
  oom:
    resources: { memory_mb: 64 }
    steps: [{ run: "node -e \\"const a=[]; for(;;) a.push(Buffer.alloc(8*1024*1024, 1))\\"" }]
  disk:
    resources: { disk_mb: 64 }
    steps: [{ run: "dd if=/dev/zero of=big bs=1M count=400 status=none; sleep 30" }]
`;

let db: FeltDbProcess;
before(async () => { if (!skip) { db = new FeltDbProcess(); await db.start(); } });
after(async () => { await db?.stop(); });

test("e2e vertical slice on a real commit with the hardened Docker executor", { skip, timeout: 240_000 }, async () => {
  const scm = new FakeScm(); // GitHub API stand-in for reads/statuses; checkout is real git against github.com
  scm.files.set(`${REPO}@${SHA}`, PIPELINE);
  const cp = new ControlPlane({ store: db.store(), scm, secrets: new MapSecrets({}), leaseMs: 15_000 });
  const cas = new ContentStore({ root: mkdtempSync(join(tmpdir(), "cas-")), minFreeBytes: 0 });
  const server = createControlServer({ cp, cas, webhookSecret: "e2e-secret", operators: {} });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as any).port}`;
  try {

  // Signed GitHub push webhook.
  const payload = JSON.stringify({ ref: "refs/heads/main", after: SHA, repository: { full_name: REPO }, sender: { login: "randy" } });
  const res = await fetch(`${url}/webhooks/github`, { method: "POST", body: payload, headers: {
    "x-github-event": "push", "x-github-delivery": "e2e-1", "x-hub-signature-256": "sha256=" + createHmac("sha256", "e2e-secret").update(payload).digest("hex"),
  } });
  assert.equal(res.status, 201);
  const { runId } = await res.json() as any;

  const token = await cp.createWorker("e2e-worker", ["linux-small", "linux-build"]);
  const agent = new WorkerAgent({ controlUrl: url, token, capabilities: ["linux-small", "linux-build", "release"], workRoot: mkdtempSync(join(tmpdir(), "work-")), executor: new OciExecutor({ diskPollMs: 500 }) });
  const caps = await agent.register();
  assert.deepEqual(caps, ["linux-build", "linux-small"], "advertised 'release' was not granted by the operator");
  for (let i = 0; i < 6 && (await agent.runOnce()); i++);

  const run = (await cp.store.get<RunRec>(C.runs, runId))!;
  const jobs = Object.fromEntries((await cp.store.query<JobRec>(C.jobs, [{ field: "runId", eq: runId }], { limit: 50 })).map((j) => [j.key, j]));
  const logOf = async (k: string) => cp.readLog(jobs[k].attemptId!);

  const checkLog = await logOf("check");
  assert.equal(jobs.check.state, "succeeded", checkLog);
  assert.match(checkLog, /network: none/);
  assert.match(checkLog, /rootfs: read-only/);
  assert.match(checkLog, /uid=65534/);
  assert.match(checkLog, /::step:: produce artifact/);
  assert.match(checkLog, new RegExp(`source ${REPO}@${SHA}`));
  assert.equal(jobs.package.state, "succeeded", await logOf("package"));

  assert.equal(jobs.oom.state, "failed");
  assert.match(jobs.oom.reason ?? "", /exit code|killed/);
  assert.equal(jobs.disk.state, "failed");
  assert.match(jobs.disk.reason ?? "", /workspace exceeded 64 MiB/);
  assert.equal(run.state, "failed");

  // Artifact: content-addressed, verified, attributed to attempt + definition digest.
  const attempt = (await cp.store.get<AttemptRec>(C.attempts, jobs.check.attemptId!))!;
  assert.equal(attempt.artifacts.length, 1);
  const art = attempt.artifacts[0];
  assert.equal(await cas.verify(art.digest), true);
  const ref = (await cp.store.query(C.artifactRefs, [{ field: "digest", eq: art.digest }], { limit: 5 }))[0];
  assert.equal(ref.sha, SHA);
  assert.equal(run.sourceDigest?.length, 64);

  await cp.deliverStatuses(1000);
  const contexts = scm.statuses.map((s) => `${s.context}=${s.state}`);
  assert.ok(contexts.includes("boundry-ci/check=success"), contexts.join(","));
  assert.ok(contexts.includes("boundry-ci/oom=failure"));
  assert.ok(contexts.includes("boundry-ci=failure"));

  // Workspaces and containers are cleaned up.
  const left = spawnSync("docker", ["ps", "-aq", "--filter", "label=com.boundry.owner=boundry-ci"]).stdout.toString().trim();
  assert.equal(left, "");
    console.log(JSON.stringify({ runId, sourceDigest: run.sourceDigest, planDigest: run.planDigest, jobs: Object.fromEntries(Object.entries(jobs).map(([k, j]) => [k, `${j.state}${j.reason ? ` (${j.reason})` : ""}`])), artifact: art, statuses: contexts }, null, 2));
  } finally { server.close(); }
});
