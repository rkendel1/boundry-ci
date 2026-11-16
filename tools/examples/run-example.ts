// Execute an example recipe against a REAL repository commit through the EXISTING engine:
// real feltdb-server, control-plane HTTP API, worker agents, git checkout of the commit from github.com,
// hardened containers, content-addressed artifacts, status outbox.
//
// What is overlaid (and recorded as such in the evidence): the recipe file is supplied from
// examples/recipes/<repo>/ as if it were committed at .boundry/recipes/, because this session cannot push to
// those repositories. Repository files are read from a local checkout verified to be at that exact commit.
// Statuses are captured, not sent to GitHub (no GitHub App exists yet).
//
// Usage: node tools/examples/run-example.ts <example> <checkoutDir>    (example: resolver | pax | distribution-protocol)
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { FeltDbProcess } from "../../test/helpers.ts";
import { ControlPlane, C, AuthorityError, type RunRec, type JobRec } from "../../src/control/core.ts";
import { createControlServer } from "../../src/control/http.ts";
import { ContentStore } from "../../src/artifacts/cas.ts";
import { WorkerAgent } from "../../src/worker/agent.ts";
import { OciExecutor } from "../../src/worker/executor.ts";
import type { ScmAdapter, CommitState } from "../../src/scm/types.ts";
import { RECIPES_DIR } from "../../src/recipes/compile.ts";

const EXAMPLES: Record<string, { repo: string; recipe: string; event: "pull_request" | "manual"; approve?: { as: string; refuse: string } }> = {
  resolver: { repo: "rkendel1/resolver", recipe: "check.md", event: "pull_request" },
  pax: { repo: "rkendel1/pax", recipe: "check.md", event: "pull_request" },
  "distribution-protocol": { repo: "rkendel1/distribution-protocol", recipe: "release.md", event: "manual", approve: { as: "randy", refuse: "mallory" } },
};

const [name, checkout, label] = process.argv.slice(2);
const evidenceName = label ? `${name}-${label}` : name;
const ex = EXAMPLES[name];
if (!ex || !checkout) { console.error(`usage: run-example.ts <${Object.keys(EXAMPLES).join("|")}> <checkoutDir>`); process.exit(2); }
const sha = execFileSync("git", ["-C", checkout, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const remote = execFileSync("git", ["-C", checkout, "remote", "get-url", "origin"], { encoding: "utf8" }).trim();
if (!remote.toLowerCase().includes(ex.repo.toLowerCase())) throw new Error(`${checkout} is ${remote}, not ${ex.repo}`);
if (execFileSync("git", ["-C", checkout, "status", "--porcelain"], { encoding: "utf8" }).trim()) throw new Error(`${checkout} has local changes`);
const recipePath = `${RECIPES_DIR}/${ex.recipe}`;
const recipeSource = readFileSync(join("examples/recipes", name, ex.recipe), "utf8");

const statuses: { context: string; state: CommitState; description: string }[] = [];
const scm: ScmAdapter = {
  provider: "github",
  async readFile(_r, s, path) {
    if (s !== sha) throw new Error("unexpected commit");
    if (path === recipePath) return recipeSource; // overlay
    try { return execFileSync("git", ["-C", checkout, "show", `${sha}:${path}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }); } catch { return null; }
  },
  async listFiles(_r, s, dir) {
    if (s !== sha) throw new Error("unexpected commit");
    if (dir === RECIPES_DIR) return [ex.recipe];
    try { return execFileSync("git", ["-C", checkout, "ls-tree", "--name-only", `${sha}:${dir === "." ? "" : dir}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim().split("\n").filter(Boolean).sort(); } catch { return null; }
  },
  async resolveBranch() { return sha; },
  async reportStatus(_r, _s, st) { statuses.push({ context: st.context, state: st.state, description: st.description }); },
  async checkoutAuth(r) { return { url: `https://github.com/${r}.git` }; },
};

const db = new FeltDbProcess();
await db.start();
const cp = new ControlPlane({ store: db.store(), scm, secrets: { async resolve(repo, names) { throw new Error(`${names.join(", ")} is not configured for ${repo} (no secret file)`); } }, leaseMs: 60_000 });
const cas = new ContentStore({ root: mkdtempSync(join(tmpdir(), "ex-cas-")), minFreeBytes: 0 });
const server = createControlServer({ cp, cas, webhookSecret: "unused", operators: {} });
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${(server.address() as any).port}`;
const started = Date.now();
try {
  const ev = { provider: "github", deliveryId: `example-${name}-${sha}`, kind: ex.event, repository: ex.repo, ref: ex.event === "pull_request" ? "refs/pull/1/head" : "refs/heads/main", sha, trusted: true, baseBranch: "main", actor: ex.event === "manual" ? "randy" : "example" } as const;
  const r = await cp.intake(ev);
  if (r.runIds.length !== 1) throw new Error(`expected one run, got ${JSON.stringify(r)}`);
  const runId = r.runIds[0];
  const caps = ["linux-small", "linux-build", "release"];
  const agents = [1, 2].map(async (i) => new WorkerAgent({
    controlUrl: url, token: await cp.createWorker(`example-w${i}`, caps), capabilities: caps,
    workRoot: mkdtempSync(join(tmpdir(), `ex-work${i}-`)), executor: new OciExecutor({ egressCaFile: process.env.BCI_EGRESS_CA_FILE }),
  }));
  const workers = await Promise.all(agents);
  for (const w of workers) await w.register();
  const approvalLog: string[] = [];
  for (let idle = 0; idle < 3;) {
    const did = await Promise.all(workers.map((w) => w.runOnce().catch((e) => { console.error("worker:", e.message); return false; })));
    const run = (await cp.store.get<RunRec>(C.runs, runId))!;
    if (run.state !== "running") break;
    const waiting = (await cp.store.query<JobRec>(C.jobs, [{ field: "runId", eq: runId }, { field: "state", eq: "awaiting_approval" }], { limit: 10 }));
    for (const j of waiting) {
      if (!ex.approve) throw new Error("unexpected approval gate");
      try { await cp.approve(j.id, ex.approve.refuse); approvalLog.push(`${ex.approve.refuse} approved ${j.key} — NOT REFUSED`); }
      catch (e) { approvalLog.push(`${ex.approve.refuse} tried to approve “${j.spec.name}”: refused (${(e as AuthorityError).message})`); }
      await cp.approve(j.id, ex.approve.as);
      approvalLog.push(`${ex.approve.as} approved “${j.spec.name}”`);
    }
    idle = did.some(Boolean) || waiting.length ? 0 : idle + 1;
  }
  await cp.deliverStatuses(1000);
  const evidence: any = await cp.evidence(runId);
  // Attach log tails and re-verify every kept artifact against the store.
  for (const j of evidence.jobs) for (const a of j.attempts) {
    const log = await cp.readLog(a.id);
    a.logTail = log.split("\n").slice(-25).join("\n");
    a.logBytes = Buffer.byteLength(log);
    for (const art of a.artifacts) art.verifiedInStore = await cas.verify(art.digest);
  }
  const out = {
    example: evidenceName, repository: ex.repo, commit: sha, overlay: { recipe: recipePath, from: `examples/recipes/${name}/${ex.recipe}` },
    durationSeconds: Math.round((Date.now() - started) / 1000), approvals: approvalLog, statusesCaptured: statuses, evidence,
  };
  mkdirSync("docs/recipes/evidence", { recursive: true });
  writeFileSync(`docs/recipes/evidence/${evidenceName}.json`, JSON.stringify(out, null, 2) + "\n");
  console.log(JSON.stringify({ run: runId, state: evidence.run.state, jobs: evidence.jobs.map((j: any) => `${j.key}=${j.state}${j.reason ? ` (${j.reason})` : ""}`), approvals: approvalLog, seconds: out.durationSeconds }, null, 2));
} finally {
  server.close();
  await db.stop();
  void readdirSync; void basename;
}
