import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { compileRecipeSource, RecipeError, type CompiledRecipe } from "../src/recipes/compile.ts";
import { explain, diffCompiled } from "../src/recipes/explain.ts";
import type { FileSource } from "../src/recipes/facts.ts";
import { FeltDbProcess, FakeScm, MapSecrets, sha } from "./helpers.ts";
import { ControlPlane, C, type RunRec, type JobRec, type WorkerRec } from "../src/control/core.ts";

const tree = (files: Record<string, string>): FileSource => ({
  async list(dir) {
    const pre = dir === "." ? "" : `${dir}/`;
    const n = new Set(Object.keys(files).filter((p) => p.startsWith(pre)).map((p) => p.slice(pre.length).split("/")[0]));
    return n.size ? [...n].sort() : null;
  },
  async read(p) { return files[p] ?? null; },
});
const NODE = { "package.json": JSON.stringify({ name: "app", main: "dist/index.js", scripts: { build: "tsc", test: "vitest run", typecheck: "tsc --noEmit", lint: "eslint ." } }), "package-lock.json": "{}" };
const RUST = { "Cargo.toml": '[package]\nname = "pax"\nedition = "2024"\n', "Cargo.lock": "" };
const PR = { repository: "acme/app", kind: "pull_request" as const, ref: "refs/pull/1/head", sha: sha(1), trusted: true, baseBranch: "main" };

const CHECK = `# Check my changes

## When this happens
- Someone proposes a change or updates the main branch.

## Make sure
- The application builds.
- The tests pass.

## Keep
- The build output.
- The test results.

## Afterward
- Report the result on the change.

## About this project
- The build output is in \`dist\`.
`;

const RELEASE = `# Prepare a release

## When this happens
- I approve a release.

## Make sure
- The tests pass.

## Steps
1. Package the result.
2. Verify the package.
3. Ask randy to approve the release.
4. Publish the package to npm.

## Keep
- The package for 400 days.
- The release evidence.
`;

const compileOk = (src: string, files: Record<string, string>, ctx: any = null) => compileRecipeSource(src, ".boundry/recipes/x.md", tree(files), ctx);
async function diagnostics(src: string, files: Record<string, string>) {
  try { await compileOk(src, files); } catch (e) { if (e instanceof RecipeError) return e.diagnostics; throw e; }
  assert.fail("expected the recipe to be refused");
}

test("R1 compilation is deterministic; recipe, facts and catalog versions are recorded", async () => {
  const a = await compileOk(CHECK, NODE, PR), b = await compileOk(CHECK, NODE, PR);
  assert.equal(a.planDigest, b.planDigest);
  assert.equal(a.definitionDigest, b.definitionDigest);
  assert.equal(JSON.stringify(a.plan), JSON.stringify(b.plan));
  assert.equal(a.compiler, "boundry-recipes/1.0.0");
  assert.equal(a.catalog, "boundry-capabilities/1.0.1");
  assert.equal(a.capabilities["check.tests"], "1.0.0");
  const otherCommit = await compileOk(CHECK, NODE, { ...PR, sha: sha(2) });
  assert.equal(otherCommit.definitionDigest, a.definitionDigest, "what runs does not depend on the commit");
  const otherFacts = await compileOk(CHECK, { ...NODE, "package.json": NODE["package.json"].replace("vitest run", "jest") }, PR);
  assert.notEqual(otherFacts.factsDigest, a.factsDigest);
  assert.notEqual(otherFacts.definitionDigest, a.definitionDigest);
});

test("R2 the person's example: vague outcomes are refused with concrete suggestions; unknown output location is asked, not guessed", async () => {
  const d = await diagnostics(CHECK.replace("- The tests pass.", "- The tests pass.\n- Nothing important breaks.").replace(/## About this project\n.*\n/, ""), NODE);
  const vague = d.find((x) => /nothing important breaks/.test(x.message))!;
  assert.equal(vague.severity, "error");
  assert.ok(vague.suggestions!.includes("The tests pass"));
  const out = d.find((x) => x.severity === "decision")!;
  assert.match(out.message, /where does the build put its output/);
  assert.match(out.message, /`dist`/, "suggestion derived from package.json main");
});

test("R3 consequential actions: never without approval, never on proposed changes, never ambiguous", async () => {
  const noApproval = await diagnostics(RELEASE.replace("3. Ask randy to approve the release.\n", ""), NODE);
  assert.ok(noApproval.some((x) => /needs an approval first/.test(x.message)));
  const onPr = await diagnostics(RELEASE.replace("- I approve a release.", "- Someone proposes a change."), NODE);
  assert.ok(onPr.some((x) => /can't run when a change is proposed/.test(x.message)));
  const dangling = await diagnostics(RELEASE.replace("4. Publish the package to npm.\n", "").replace("3. Ask", "3. Ask"), NODE);
  assert.ok(dangling.some((x) => /must be followed by the step it approves/.test(x.message)));
  const where = await diagnostics(RELEASE.replace("Publish the package to npm", "Publish the package"), NODE);
  assert.ok(where.some((x) => x.severity === "decision" && /where should the package be published/.test(x.message)));
  const noPackage = await diagnostics(RELEASE.replace("1. Package the result.\n", ""), NODE);
  assert.ok(noPackage.some((x) => /needs a package/.test(x.message)));
});

test("R4 unavailable capabilities are reported, never approximated", async () => {
  const d = await diagnostics(`# Ship\n## When this happens\n- I start it.\n## Make sure\n- Browser tests pass.\n## Steps\n1. Ask sam to approve.\n2. Deploy the application.\n## Afterward\n- Tell sam.\n`, NODE);
  const unsupported = d.filter((x) => x.severity === "unsupported").map((x) => x.message).join(" | ");
  assert.match(unsupported, /Browser tests pass/);
  assert.match(unsupported, /Deploy the application/);
  assert.match(unsupported, /Tell sam/);
});

test("R5 project understanding: ambiguity is a decision; the person's statement resolves it; missing lockfile refused", async () => {
  const both = await diagnostics(`# Check\n## When this happens\n- Someone proposes a change.\n## Make sure\n- The tests pass.\n`, { ...NODE, ...RUST });
  assert.ok(both.some((x) => x.severity === "decision" && /more than one kind of project/.test(x.message)));
  const rust = await compileOk(`# Check\n## When this happens\n- Someone proposes a change.\n## Make sure\n- The tests pass.\n## About this project\n- This is a Rust project.\n`, { ...NODE, ...RUST });
  assert.equal(rust.ecosystem, "rust");
  assert.match(rust.plan.jobs[0].steps.map((s) => s.run).join("\n"), /cargo test --locked/);
  const nolock = await diagnostics(`# Check\n## When this happens\n- Someone proposes a change.\n## Make sure\n- The tests pass.\n`, { "package.json": NODE["package.json"] });
  assert.ok(nolock.some((x) => /no lockfile/.test(x.message)));
  const sub = await compileOk(`# Check\n## When this happens\n- Someone proposes a change.\n## Make sure\n- The tests pass.\n## About this project\n- The application is in \`services/api\`.\n`, Object.fromEntries(Object.entries(RUST).map(([k, v]) => [`services/api/${k}`, v])));
  assert.equal(sub.facts.dir, "services/api");
  const none = await diagnostics(`# Check\n## When this happens\n- Someone proposes a change.\n## Make sure\n- The tests pass.\n`, { "README.md": "hi" });
  assert.ok(none.some((x) => x.severity === "decision" && /couldn't tell what kind of project/.test(x.message)));
});

test("R6 the compiler adds nothing consequential on its own", async () => {
  const c = await compileOk(CHECK.replace("## Afterward\n- Report the result on the change.\n", ""), NODE, PR);
  for (const j of c.plan.jobs) {
    assert.deepEqual(j.permissions, { release: false, deploy: false });
    assert.deepEqual(j.secrets, []);
    assert.equal(j.approval.required, false);
    assert.ok(!j.requires.includes("release") && !j.requires.includes("deploy"));
  }
  assert.equal(c.plan.report, false, "no reporting unless asked");
  const r = await compileOk(RELEASE, NODE, { ...PR, kind: "manual", ref: "refs/heads/main" });
  const pub = r.plan.jobs.find((j) => j.key.endsWith("publish-npm"))!;
  assert.deepEqual(pub.secrets, ["NPM_TOKEN"]);
  assert.equal(pub.permissions.release, true);
  assert.deepEqual(pub.approval, { required: true, approvers: ["randy"] });
  assert.deepEqual(pub.inputs, [{ job: "step-package", artifact: "package.tar" }]);
  assert.equal(pub.retry.maxAttempts, 1, "consequential steps are never retried automatically");
  assert.deepEqual(pub.cache, [], "consequential steps never use caches");
  const verify = r.plan.jobs.find((j) => j.key === "step-verify-package")!;
  assert.deepEqual(verify.needs, ["step-package"]);
  assert.deepEqual(r.plan.jobs.find((j) => j.key === "step-package")!.needs, ["tests"]);
  assert.equal(verify.network, "none");
  assert.equal(r.plan.jobs.find((j) => j.key === "step-package")!.artifacts[0].retentionDays, 400);
});

test("R7 a recipe change produces a reviewable plan change, consequential changes first", async () => {
  const base = await compileOk(RELEASE.replace("3. Ask randy to approve the release.\n4. Publish the package to npm.\n", ""), NODE);
  const withPublish = await compileOk(RELEASE, NODE);
  const d = diffCompiled(base, withPublish);
  assert.equal(d.changed, true);
  assert.match(d.text, /NEW PERMISSION: release/);
  assert.match(d.text, /NEW SECRET: NPM_TOKEN/);
  assert.match(d.text, /approval added: randy→step-publish-npm/);
  assert.match(d.text, /\+ step-publish-npm/);
  assert.equal(diffCompiled(withPublish, await compileOk(RELEASE + "\n", NODE)).changed, false, "whitespace-only change: what runs is identical");
});

test("R8 triggers: only matching events produce jobs", async () => {
  assert.ok((await compileOk(CHECK, NODE, PR)).plan.jobs.length > 0);
  assert.ok((await compileOk(CHECK, NODE, { ...PR, kind: "push", ref: "refs/heads/main" })).plan.jobs.length > 0);
  assert.equal((await compileOk(CHECK, NODE, { ...PR, kind: "push", ref: "refs/heads/feature" })).plan.jobs.length, 0);
  assert.equal((await compileOk(CHECK, NODE, { ...PR, kind: "tag", ref: "refs/tags/v1.0.0" })).plan.jobs.length, 0);
  const nightly = CHECK.replace("- Someone proposes a change or updates the main branch.", "- Every day at 06:30 UTC.");
  const c = await compileOk(nightly, NODE, { ...PR, kind: "schedule", ref: "refs/heads/main", cron: "30 6 * * *" });
  assert.equal(c.triggers[0].cron, "30 6 * * *");
  assert.ok(c.plan.jobs.length > 0);
});

test("R9 explanation names everything that will run and every authority it uses", async () => {
  const text = explain(await compileOk(RELEASE, NODE));
  for (const s of ["Publishes or deploys: “Publish the package to npm”", "**release**", "`NPM_TOKEN`", "randy before “Publish the package to npm”", "uses `package.tar` (digest-verified)", "(partial)"]) assert.ok(text.includes(s), `missing: ${s}\n${text}`);
});

// ── through the real control plane ──
let db: FeltDbProcess;
before(async () => { db = new FeltDbProcess(); await db.start(); });
after(async () => { await db.stop(); });

test("R10 intake: one run per matching recipe, with intent, facts, plan and explanation recorded; reporting only when asked", async () => {
  const scm = new FakeScm();
  const s = sha(10);
  scm.trees.set(`acme/app@${s}`, {
    ...NODE,
    ".boundry/recipes/check.md": CHECK,
    ".boundry/recipes/quiet.md": CHECK.replace("# Check my changes", "# Quiet checks").replace("## Afterward\n- Report the result on the change.\n", ""),
    ".boundry/recipes/release.md": RELEASE,
    ".boundry/recipes/broken.md": "# Broken\n## When this happens\n- Someone proposes a change.\n## Make sure\n- Nothing important breaks.\n",
    ".boundry/ci.yaml": "version: 1\njobs: { x: { image: x, steps: [{run: x}] } }\n",
  });
  const cp = new ControlPlane({ store: db.store(), scm, secrets: new MapSecrets({}) });
  const r = await cp.intake({ provider: "github", deliveryId: "r10", kind: "pull_request", repository: "acme/app", ref: "refs/pull/1/head", sha: s, trusted: true, baseBranch: "main" });
  assert.equal(r.runIds.length, 3, "check, quiet, and the broken recipe (release does not match a proposed change)");
  const runs = await Promise.all(r.runIds.map((id) => cp.store.get<RunRec>(C.runs, id)));
  const check = runs.find((x) => x!.definitionPath === ".boundry/recipes/check.md")! as any;
  assert.equal(check.recipe.title, "Check my changes");
  assert.equal(check.recipe.compiler, "boundry-recipes/1.0.0");
  assert.ok(check.recipe.facts.evidence.includes("package.json"));
  assert.match(check.explanation, /## Checks \(2 jobs at the same time\)/);
  const broken = runs.find((x) => x!.definitionPath === ".boundry/recipes/broken.md")!;
  assert.equal(broken.state, "failed");
  assert.match(broken.reason!, /nothing important breaks/);
  const ob = await cp.store.query(C.outbox, [], { limit: 100 });
  const contexts = ob.map((o: any) => o.context).sort();
  assert.ok(contexts.includes("boundry/check") && contexts.includes("boundry/check/tests"));
  assert.ok(contexts.includes("boundry/broken"), "a recipe that can't run is reported, so the author sees it");
  assert.ok(!contexts.some((c: string) => c.startsWith("boundry/quiet")), "no reporting when the recipe doesn't ask");
  assert.ok(!contexts.some((c: string) => c.startsWith("boundry-ci")), "recipes take precedence over the legacy file");
  const def = await cp.store.get(C.defs, `def_${check.sourceDigest}`);
  assert.equal(def!.source, CHECK, "the original recipe text is preserved by digest");
});

test("R11 artifact inputs: resolved to exact digests at lease, recorded on the attempt, readable only by the lease holder", async () => {
  const own = new FeltDbProcess(); await own.start(); // leasing is global: isolate from R10's queued jobs
  try { await r11(own); } finally { await own.stop(); }
});
async function r11(db: FeltDbProcess) {
  const scm = new FakeScm();
  const s = sha(11);
  scm.trees.set(`acme/rel@${s}`, { ...NODE, ".boundry/recipes/release.md": RELEASE.replace("3. Ask randy to approve the release.\n4. Publish the package to npm.\n", "") });
  const cp = new ControlPlane({ store: db.store(), scm, secrets: new MapSecrets({}) });
  const r = await cp.intake({ provider: "boundry", deliveryId: "r11", kind: "manual", repository: "acme/rel", ref: "refs/heads/main", sha: s, trusted: true });
  const tok = await cp.createWorker("r11w", ["linux-small"]);
  await cp.registerWorker(await cp.authenticateWorker(tok), ["linux-small"], {});
  const w = () => cp.store.get<WorkerRec>(C.workers, "r11w") as Promise<WorkerRec>;
  const finish = async (key: string, artifacts: any[] = []) => {
    const g = (await cp.lease(await w()))!;
    assert.equal(g.job.key, key);
    await cp.start("r11w", g.attemptId, g.leaseId);
    for (const a of artifacts) await cp.store.transact(`a-${a.digest}`, [{ collection: C.artifacts, id: `sha256-${a.digest}`, requireAbsent: true, value: { size: a.size } }]).catch(() => {});
    await cp.complete("r11w", g.attemptId, g.leaseId, { outcome: "succeeded", exitCode: 0, artifacts });
    return g;
  };
  await finish("tests");
  const pkg = { name: "package.tar", digest: "a".repeat(64), size: 10 };
  await finish("step-package", [pkg]);
  const g = (await cp.lease(await w()))!;
  assert.equal(g.job.key, "step-verify-package");
  assert.deepEqual(g.inputs.map((i) => [i.name, i.digest, i.fromJob]), [["package.tar", pkg.digest, "step-package"]]);
  const att = await cp.store.get(C.attempts, g.attemptId) as any;
  assert.equal(att.inputs[0].digest, pkg.digest);
  assert.equal((await cp.inputFor("r11w", g.attemptId, g.leaseId, "package.tar")).digest, pkg.digest);
  await assert.rejects(cp.inputFor("r11w", g.attemptId, "wrong-lease", "package.tar"));
  await assert.rejects(cp.inputFor("r11w", g.attemptId, g.leaseId, "other.tar"));
  const ev: any = await cp.evidence(r.runIds[0]);
  assert.equal(ev.definition.source.startsWith("# Prepare a release"), true);
  assert.equal(ev.trigger.kind, "manual");
  assert.ok(ev.jobs.find((j: any) => j.key === "step-package").attempts[0].artifacts[0].digest === pkg.digest);
  assert.ok(ev.jobs.every((j: any) => j.capabilities.length >= 1));
}

test("R12 least privilege: a release authority's token submits build-only executions and reads only its own runs", async () => {
  const { createControlServer } = await import("../src/control/http.ts");
  const { ContentStore } = await import("../src/artifacts/cas.ts");
  const { createHash } = await import("node:crypto");
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const h = (t: string) => createHash("sha256").update(t).digest("hex");
  const scm = new FakeScm();
  const s = sha(12);
  scm.trees.set(`acme/app@${s}`, { ...NODE });
  const cp = new ControlPlane({ store: db.store(), scm, secrets: new MapSecrets({}) });
  const cas = new ContentStore({ root: mkdtempSync(join(tmpdir(), "cas-")), minFreeBytes: 0 });
  const RO = ["executions:submit", "runs:read", "artifacts:read"];
  const server = createControlServer({ cp, cas, webhookSecret: "x", operators: { [h("admin-t")]: "ops", [h("rel-t")]: { who: "boundry-maintenance", scopes: RO }, [h("other-t")]: { who: "someone-else", scopes: RO } } });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const call = (tok: string, method: string, path: string, body?: unknown) => fetch(`${base}${path}`, { method, headers: { authorization: `Bearer ${tok}`, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  try {
    const sub = await call("rel-t", "POST", "/v1/executions", { requestId: "rel-1", repository: "acme/app", commit: s, branch: "main", recipe: { path: ".boundry/recipes/boundry-release.md", source: CHECK.replace("- Someone proposes a change or updates the main branch.", "- I start it.") } });
    assert.equal(sub.status, 201, await sub.clone().text());
    const subj: any = await sub.json();
    const runId = subj.runIds[0];
    assert.ok(runId, JSON.stringify(subj));
    assert.equal((await call("rel-t", "GET", `/v1/runs/${runId}`)).status, 200, "reads its own run");
    assert.equal((await call("rel-t", "GET", `/v1/runs/${runId}/evidence`)).status, 200);
    assert.equal((await call("other-t", "GET", `/v1/runs/${runId}`)).status, 404, "another submitter cannot see it");
    assert.equal((await call("other-t", "GET", `/v1/runs/${runId}/evidence`)).status, 404);
    assert.equal((await call("admin-t", "GET", `/v1/runs/${runId}`)).status, 200, "admin sees everything");
    for (const [m, p, b] of [["POST", `/v1/runs/${runId}/cancel`], ["POST", `/v1/jobs/x/approve`], ["POST", "/v1/dispatch", { repository: "acme/app", sha: s }], ["GET", "/v1/diag/summary"], ["POST", "/v1/diag/canary"]] as const)
      assert.equal((await call("rel-t", m, p, b)).status, 403, `${m} ${p} needs admin`);
    assert.equal((await call("nobody", "GET", `/v1/runs/${runId}`)).status, 401);
    // An execution request asking for publication: compiled, but its publishing job never gets secrets or release authority.
    const rel = await call("rel-t", "POST", "/v1/executions", { requestId: "rel-2", repository: "acme/app", commit: s, branch: "main", recipe: { path: ".boundry/recipes/release.md", source: RELEASE } });
    const relRun = (await rel.json() as any).runIds?.[0];
    const jobs = await cp.store.query<JobRec>(C.jobs, [{ field: "runId", eq: relRun }], { limit: 100 });
    const privileged = jobs.filter((j: any) => j.spec.secrets.length || j.spec.permissions.release || j.spec.permissions.deploy);
    assert.ok(privileged.length > 0, "the release recipe does ask for publication authority");
    for (const j of privileged) { assert.equal(j.state, "failed"); assert.match(j.reason!, /build-only/); }
  } finally { server.close(); }
});
