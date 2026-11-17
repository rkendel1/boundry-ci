// Boundry CI control plane core. FeltDB is the only authority for state; this module
// holds no state between calls, so any number of restarts are safe.
//
// Job lifecycle:
//   waiting -> queued | awaiting_approval -> queued -> leased -> running -> succeeded | failed | cancelled
//   waiting -> skipped (a dependency did not succeed)
//   leased|running --(lease expired / worker lost / timeout)--> queued (retry) | failed | cancelled
// Every lease creates a new, independently identified attempt record; attempts are never overwritten
// once terminal.
import { randomUUID } from "node:crypto";
import { compile, parseSpec, SpecError, SPEC_PATH, type PlanJob, type Plan } from "../spec/compile.ts";
import { compileRecipeSource, RecipeError, RECIPES_DIR, type CompiledRecipe } from "../recipes/compile.ts";
import { explain, explainDiagnostics } from "../recipes/explain.ts";
import type { FileSource } from "../recipes/facts.ts";
import { sha256Hex, canonicalJson, stableId } from "../canonical.ts";
import { FeltStore, PreconditionFailed, body, fenceOf, type Rec, type TxOp } from "../store/feltdb.ts";
import type { ScmAdapter, SourceEvent, CommitState } from "../scm/types.ts";
import { nextFire } from "./cron.ts";

export const C = {
  events: "ci_events",
  defs: "ci_pipeline_defs",
  runs: "ci_runs",
  jobs: "ci_jobs",
  attempts: "ci_attempts",
  workers: "ci_workers",
  logs: "ci_log_chunks",
  artifacts: "ci_artifacts",
  artifactRefs: "ci_artifact_refs",
  approvals: "ci_approvals",
  outbox: "ci_outbox",
  schedules: "ci_schedules",
} as const;

export type JobState = "waiting" | "awaiting_approval" | "queued" | "leased" | "running" | "succeeded" | "failed" | "cancelled" | "skipped";
const TERMINAL = new Set<JobState>(["succeeded", "failed", "cancelled", "skipped"]);
const ACTIVE = new Set<JobState>(["leased", "running"]);

export interface JobRec extends Rec {
  runId: string; key: string; state: JobState; attempts: number; spec: PlanJob;
  trusted: boolean; repository: string; sha: string; queuedAt: number | null;
  leaseId: string | null; leaseExpiresAt: number | null; workerId: string | null; attemptId: string | null;
  startedAt: number | null; finishedAt: number | null; reason: string | null; cancelRequested: boolean;
}
export interface RunRec extends Rec {
  repository: string; eventId: string; kind: string; ref: string; sha: string; trusted: boolean;
  pipeline: string; sourceDigest: string | null; planDigest: string | null; state: string;
  concurrencyGroup: string | null; createdAt: number; finishedAt: number | null; cancelRequested: boolean;
  reason: string | null; downstream: { repository: string; ref: string | null }[];
}
export interface AttemptRec extends Rec {
  jobId: string; runId: string; n: number; workerId: string; leaseId: string; state: string;
  leasedAt: number; startedAt: number | null; finishedAt: number | null; exitCode: number | null;
  reason: string | null; resultDigest: string | null; artifacts: { name: string; digest: string; size: number }[];
  image: string; logChunks: number;
}
export interface WorkerRec extends Rec {
  tokenHash: string; allowedCapabilities: string[]; capabilities: string[]; resources: Record<string, unknown>;
  registeredAt: number | null; lastHeartbeatAt: number | null; disabled: boolean;
}

export interface SecretProvider {
  /** Resolve named secrets for a repository; must refuse names not scoped to it. */
  resolve(repository: string, names: string[]): Promise<Record<string, string>>;
}

export interface ControlOptions {
  store: FeltStore;
  scm: ScmAdapter;
  secrets: SecretProvider;
  now?: () => number;
  leaseMs?: number;
  publicUrl?: string;
}

export class AuthorityError extends Error {}
export class NotFound extends Error {}
export class Conflict extends Error {}

/** Repositories under `_boundry/` are platform-internal (canaries). `_` is not valid in a GitHub owner name. */
export const INTERNAL_OWNER = "_boundry";
export const isInternal = (repository: string) => repository.startsWith(`${INTERNAL_OWNER}/`);
const pushOp = (ops: TxOp[], op: TxOp | null) => { if (op) ops.push(op); };
/** Status context prefix stored on runs/jobs: null = do not report; records from before recipes report as "boundry-ci". */
const prefixOf = (r: { statusPrefix?: unknown }): string | null => (r.statusPrefix === undefined ? "boundry-ci" : (r.statusPrefix as string | null));
const jobCtx = (prefix: string | null, key: string) => (prefix === null ? null : `${prefix}/${key}`);
interface Unit { runId: string; path: string; source: string; sourceDigest: string; plan: Plan | null; planDigest: string | null; error: string | null; recipe: CompiledRecipe | null; statusPrefix: string | null }

/** Read repository files at one commit through the source adapter (with a per-intake cache). */
function scmFiles(scm: ScmAdapter, repository: string, sha: string): FileSource {
  const cache = new Map<string, Promise<unknown>>();
  const memo = <T>(k: string, f: () => Promise<T>) => { if (!cache.has(k)) cache.set(k, f()); return cache.get(k) as Promise<T>; };
  return { list: (dir) => memo(`l:${dir}`, () => scm.listFiles(repository, sha, dir)), read: (path) => memo(`r:${path}`, () => scm.readFile(repository, sha, path)) };
}

// FeltDB record ids are [A-Za-z0-9_-]{1,128}; natural keys are hashed into that alphabet.
export const jobIdOf = (runId: string, key: string) => `${runId}-${sha256Hex(key).slice(0, 16)}`;
export const attemptIdOf = (jobId: string, n: number) => `${jobId}-a${n}`;
export const eventIdOf = (eventKey: string) => `ev_${sha256Hex(eventKey).slice(0, 40)}`;
export const defIdOf = (digest: string) => `def_${digest}`;
export const artifactIdOf = (hex: string) => `sha256-${hex}`;
const WORKER_ID = /^[a-z0-9][a-z0-9_-]{0,62}$/;

export class ControlPlane {
  readonly store: FeltStore;
  readonly scm: ScmAdapter;
  readonly secrets: SecretProvider;
  readonly now: () => number;
  readonly leaseMs: number;
  readonly publicUrl: string;

  constructor(o: ControlOptions) {
    this.store = o.store; this.scm = o.scm; this.secrets = o.secrets;
    this.now = o.now ?? Date.now; this.leaseMs = o.leaseMs ?? 60_000; this.publicUrl = o.publicUrl ?? "";
  }

  // ───────────────────────── intake ─────────────────────────

  /**
   * Ingest a source event exactly once (duplicate deliveries return the original runs). The repository's
   * Boundry Recipes (.boundry/recipes/*.md) are compiled against project facts read at the commit; each recipe
   * whose triggers match becomes one run. Repositories without recipes use the legacy .boundry/ci.yaml.
   */
  async intake(ev: SourceEvent, opts: { source?: string; recipe?: { path: string; source: string } } = {}): Promise<{ runId: string | null; runIds: string[]; duplicate: boolean; state: string }> {
    const eventKey = `${ev.provider}:${ev.deliveryId}`;
    const eventId = eventIdOf(eventKey);
    const existing = await this.store.get(C.events, eventId);
    if (existing) return { runId: (existing.runId as string) ?? null, runIds: (existing.runIds as string[]) ?? [], duplicate: true, state: String(existing.outcome) };
    if (isInternal(ev.repository) && opts.source === undefined) throw new AuthorityError("internal repositories require a supplied pipeline source");

    const now = this.now();
    const ctx = { repository: ev.repository, kind: ev.kind, ref: ev.ref, sha: ev.sha, trusted: ev.trusted, baseBranch: ev.baseBranch, cron: ev.cron };
    const units: Unit[] = [];
    // An execution request (e.g. from Boundry Maintenance) supplies the recipe; the repository supplies the facts.
    const recipeFiles = opts.recipe ? [opts.recipe.path.split("/").pop()!] : opts.source === undefined ? await this.#recipeFiles(ev) : null;
    if (recipeFiles && recipeFiles.length) {
      const files = scmFiles(this.scm, ev.repository, ev.sha);
      for (const name of recipeFiles) {
        const path = opts.recipe ? opts.recipe.path : `${RECIPES_DIR}/${name}`;
        const source = opts.recipe ? opts.recipe.source : (await files.read(path)) ?? "";
        const runId = stableId("run", eventKey, path);
        try {
          const c = await compileRecipeSource(source, path, files, ctx);
          units.push({ runId, path, source, sourceDigest: c.sourceDigest, plan: c.plan, planDigest: c.planDigest, error: null, recipe: c, statusPrefix: c.report && !isInternal(ev.repository) ? `boundry/${c.plan.recipe!.slug}` : null });
        } catch (e) {
          if (!(e instanceof RecipeError)) throw e;
          // A recipe that cannot compile is recorded as a failed run with its diagnostics, and reported.
          units.push({ runId, path, source, sourceDigest: sha256Hex(source), plan: null, planDigest: null, error: explainDiagnostics(path, e.diagnostics), recipe: null, statusPrefix: `boundry/${name.replace(/\.md$/, "").toLowerCase().replace(/[^a-z0-9]+/g, "-")}` });
        }
      }
    } else {
      const source = opts.source ?? (await this.scm.readFile(ev.repository, ev.sha, SPEC_PATH));
      if (source !== null) {
        const runId = stableId("run", eventKey);
        try {
          const { plan, planDigest } = compile(source, ctx);
          units.push({ runId, path: SPEC_PATH, source, sourceDigest: plan.sourceDigest, plan, planDigest, error: null, recipe: null, statusPrefix: isInternal(ev.repository) ? null : "boundry-ci" });
        } catch (e) {
          if (!(e instanceof SpecError)) throw e;
          units.push({ runId, path: SPEC_PATH, source, sourceDigest: sha256Hex(source), plan: null, planDigest: null, error: e.message, recipe: null, statusPrefix: "boundry-ci" });
        }
      }
    }

    const live = units.filter((u) => u.error || (u.plan && u.plan.jobs.length));
    const outcome = !units.length ? "no-pipeline" : !live.length ? "no-matching-jobs" : live.every((u) => u.error) ? "invalid-pipeline" : "run-created";
    const ops: TxOp[] = [{ collection: C.events, id: eventId, requireAbsent: true, value: {
      eventKey, provider: ev.provider, deliveryId: ev.deliveryId, kind: ev.kind, repository: ev.repository, ref: ev.ref, sha: ev.sha, trusted: ev.trusted,
      actor: ev.actor ?? null, receivedAt: now, runId: live[0]?.runId ?? null, runIds: live.map((u) => u.runId), outcome,
    } }];
    const baseRun = {
      repository: ev.repository, eventId, kind: ev.kind, ref: ev.ref, sha: ev.sha, trusted: ev.trusted, actor: ev.actor ?? null,
      createdAt: now, finishedAt: null, cancelRequested: false, concurrencyGroup: null, downstream: [] as unknown[],
    };
    const defsAdded = new Set<string>();
    for (const u of live) {
      if (!defsAdded.has(u.sourceDigest)) { ops.push(...(await this.#defOps(u.sourceDigest, ev.repository, u.source, now, u.path))); defsAdded.add(u.sourceDigest); }
      const recipeMeta = u.recipe ? {
        recipe: { path: u.path, title: u.recipe.title, sourceDigest: u.recipe.sourceDigest, compiler: u.recipe.compiler, catalog: u.recipe.catalog, capabilities: u.recipe.capabilities, facts: u.recipe.facts, factsDigest: u.recipe.factsDigest, definitionDigest: u.recipe.definitionDigest },
        explanation: explain(u.recipe),
      } : {};
      if (u.error) {
        ops.push({ collection: C.runs, id: u.runId, requireAbsent: true, value: { ...baseRun, pipeline: u.path, definitionPath: u.path, sourceDigest: u.sourceDigest, planDigest: null, state: "failed", finishedAt: now, reason: u.error.slice(0, 4000), statusPrefix: u.statusPrefix } });
        pushOp(ops, this.#statusOp(u.runId, ev.repository, ev.sha, u.statusPrefix, "failure", u.recipe === null && u.path !== SPEC_PATH ? "Recipe can't run yet — see the run's diagnostics" : "Invalid .boundry/ci.yaml", `${u.runId}:final`));
        continue;
      }
      const plan = u.plan!;
      ops.push({ collection: C.runs, id: u.runId, requireAbsent: true, value: {
        ...baseRun, pipeline: plan.pipeline, definitionPath: u.path, sourceDigest: plan.sourceDigest, planDigest: u.planDigest, state: "running", reason: null,
        concurrencyGroup: plan.concurrency?.group ?? null, cancelInProgress: plan.concurrency?.cancelInProgress ?? false, downstream: plan.downstream,
        statusPrefix: u.statusPrefix, ...recipeMeta,
      } });
      for (const pj of plan.jobs) {
        let state: JobState = pj.needs.length ? "waiting" : pj.approval.required ? "awaiting_approval" : "queued";
        let reason: string | null = null;
        // Authority: an untrusted source can never reach release/deploy capability or secrets.
        if (!ev.trusted && (pj.permissions.release || pj.permissions.deploy)) { state = "failed"; reason = "untrusted source cannot run release/deploy jobs"; }
        else if (!ev.trusted && pj.secrets.length) { state = "failed"; reason = "untrusted source cannot receive secrets"; }
        ops.push({ collection: C.jobs, id: jobIdOf(u.runId, pj.key), requireAbsent: true, value: {
          runId: u.runId, key: pj.key, state, attempts: 0, spec: pj, trusted: ev.trusted, repository: ev.repository, sha: ev.sha,
          queuedAt: state === "queued" ? now : null, leaseId: null, leaseExpiresAt: null, workerId: null, attemptId: null,
          startedAt: null, finishedAt: state === "failed" ? now : null, reason, cancelRequested: false, statusPrefix: u.statusPrefix,
        } });
        const jc = jobCtx(u.statusPrefix, pj.key);
        pushOp(ops, state === "failed"
          ? this.#statusOp(u.runId, ev.repository, ev.sha, jc, "failure", reason!, `${jobIdOf(u.runId, pj.key)}:final`)
          : this.#statusOp(u.runId, ev.repository, ev.sha, jc, "pending", "Queued", `${jobIdOf(u.runId, pj.key)}:pending`));
      }
      pushOp(ops, this.#statusOp(u.runId, ev.repository, ev.sha, u.statusPrefix, "pending", plan.recipe ? plan.pipeline.slice(0, 120) : `Run ${u.runId}`, `${u.runId}:pending`));
    }
    const res = await this.#commitIntake(eventId, ops, live.map((u) => u.runId), outcome);
    if (!res.duplicate) {
      for (const u of live) {
        if (!u.plan) continue;
        if (u.plan.concurrency?.cancelInProgress) await this.#supersede(u.runId, u.plan.concurrency.group, now);
        await this.advance(u.runId); // settles jobs that failed authority checks at intake
      }
      if (ev.kind === "push" && ev.ref.startsWith("refs/heads/")) {
        for (const u of units) {
          if (u.recipe) await this.#registerSchedules(ev, u.recipe.triggers.filter((t) => t.kind === "schedule").map((t) => ({ cron: t.cron!, branch: t.scheduleBranch! })));
          else if (u.plan && !u.error) { try { await this.#registerSchedules(ev, (parseSpec(u.source).on?.schedule ?? []).map((x: any) => ({ cron: x.cron, branch: x.branch ?? "main" }))); } catch { /* invalid */ } }
        }
      }
    }
    return res;
  }

  async #recipeFiles(ev: SourceEvent): Promise<string[] | null> {
    if (isInternal(ev.repository)) return null;
    const names = await this.scm.listFiles(ev.repository, ev.sha, RECIPES_DIR);
    return names ? names.filter((n) => /^[A-Za-z0-9][A-Za-z0-9._-]*\.md$/.test(n) && n.toLowerCase() !== "readme.md").sort() : null;
  }

  async #commitIntake(eventId: string, ops: TxOp[], runIds: string[], outcome: string) {
    try {
      const tx = await this.store.transact(`intake:${sha256Hex(canonicalJson(ops))}`, ops);
      return { runId: runIds[0] ?? null, runIds, duplicate: tx.duplicate, state: outcome };
    } catch (e) {
      // A concurrent delivery of the same event won the race: report as duplicate.
      const ev = await this.store.get(C.events, eventId);
      if (ev) return { runId: (ev.runId as string) ?? null, runIds: (ev.runIds as string[]) ?? [], duplicate: true, state: String(ev.outcome) };
      throw e;
    }
  }

  async #defOps(digest: string, repository: string, source: string, now: number, path = SPEC_PATH): Promise<TxOp[]> {
    if (await this.store.get(C.defs, defIdOf(digest))) return [];
    return [{ collection: C.defs, id: defIdOf(digest), requireAbsent: true, value: { repository, path, source, recordedAt: now } }];
  }

  /** Commit-status outbox entry; internal runs (canaries) never report to a source provider. */
  #statusOp(runId: string, repository: string, sha: string, context: string | null, state: CommitState, description: string, key: string): TxOp | null {
    if (isInternal(repository) || context === null) return null;
    return { collection: C.outbox, id: stableId("ob", key), requireAbsent: true, value: {
      kind: "scm_status", runId, repository, sha, context, state, description: description.slice(0, 140),
      targetUrl: this.publicUrl ? `${this.publicUrl}/v1/runs/${runId}` : null, delivered: false, attempts: 0, createdAt: this.now(),
    } };
  }

  // ───────────────────────── scheduling ─────────────────────────

  /**
   * Deterministically settle a run: release dependents of finished jobs, skip dependents of
   * failed ones, and finish the run when every job is terminal. Safe to call any number of times.
   */
  async advance(runId: string): Promise<void> {
    for (let attempt = 0; attempt < 8; attempt++) {
      const run = await this.store.get<RunRec>(C.runs, runId);
      if (!run) throw new NotFound(runId);
      const jobs = await this.store.query<JobRec>(C.jobs, [{ field: "runId", eq: runId }], { limit: 1000 });
      const byKey = new Map(jobs.map((j) => [j.key, j]));
      const state = new Map(jobs.map((j) => [j.key, j.state] as [string, JobState]));
      const changed = new Map<string, Partial<JobRec>>();
      const now = this.now();
      let progress = true;
      while (progress) {
        progress = false;
        for (const j of [...jobs].sort((a, b) => (a.key < b.key ? -1 : 1))) {
          if (state.get(j.key) !== "waiting") continue;
          const deps = j.spec.needs.map((k) => state.get(k));
          let next: JobState | null = null; let reason: string | null = null;
          if (run.cancelRequested) { next = "cancelled"; reason = "run cancelled"; }
          else if (deps.some((d) => d === "failed" || d === "cancelled" || d === "skipped")) { next = "skipped"; reason = "dependency did not succeed"; }
          else if (deps.every((d) => d === "succeeded")) next = j.spec.approval.required ? "awaiting_approval" : "queued";
          if (next) {
            state.set(j.key, next); progress = true;
            changed.set(j.key, { state: next, reason, queuedAt: next === "queued" ? now : null, finishedAt: TERMINAL.has(next) ? now : null });
          }
        }
      }
      const finalStates = [...state.values()];
      const allTerminal = finalStates.every((s) => TERMINAL.has(s));
      const ops: TxOp[] = [];
      for (const [key, patch] of changed) {
        const j = byKey.get(key)!;
        ops.push({ collection: C.jobs, id: j.id, expectedVersionToken: fenceOf(j), value: { ...body(j), ...patch } });
        if (patch.state && TERMINAL.has(patch.state)) pushOp(ops, this.#statusOp(runId, run.repository, run.sha, jobCtx(prefixOf(j), key), "error", patch.reason ?? patch.state, `${j.id}:final`));
      }
      if (allTerminal && run.state === "running") {
        const runState = finalStates.includes("failed") ? "failed" : finalStates.includes("cancelled") ? "cancelled" : finalStates.every((s) => s === "succeeded") ? "succeeded" : "failed";
        ops.push({ collection: C.runs, id: runId, expectedVersionToken: fenceOf(run), value: { ...body(run), state: runState, finishedAt: now } });
        pushOp(ops, this.#statusOp(runId, run.repository, run.sha, prefixOf(run), runState === "succeeded" ? "success" : runState === "cancelled" ? "error" : "failure", `Run ${runState}`, `${runId}:final`));
      }
      if (!ops.length) return;
      try {
        await this.store.transact(`advance:${randomUUID()}`, ops);
        if (allTerminal && run.state === "running") await this.#triggerDownstream(run, finalStates.every((s) => s === "succeeded"));
        return;
      } catch (e) {
        if (!(e instanceof PreconditionFailed)) throw e; // concurrent change: re-read and retry
      }
    }
    throw new Conflict(`advance(${runId}) did not converge`);
  }

  async #triggerDownstream(run: RunRec, succeeded: boolean) {
    if (!succeeded) return;
    for (const d of run.downstream ?? []) {
      const branch = d.ref ?? "main";
      const sha = await this.scm.resolveBranch(d.repository, branch);
      if (!sha) continue;
      await this.intake({ provider: "boundry", deliveryId: `upstream:${run.id}:${d.repository}`, kind: "upstream", repository: d.repository, ref: `refs/heads/${branch}`, sha, trusted: run.trusted, actor: `run:${run.id}` });
    }
  }

  async #supersede(runId: string, group: string, now: number) {
    const others = await this.store.query<RunRec>(C.runs, [{ field: "concurrencyGroup", eq: group }, { field: "state", eq: "running" }], { limit: 100 });
    const me = others.find((r) => r.id === runId);
    for (const r of others) {
      if (r.id === runId) continue;
      if (me && (r.createdAt > me.createdAt || (r.createdAt === me.createdAt && r.id > runId))) continue; // only older runs
      await this.cancelRun(r.id, `superseded by ${runId}`);
    }
    void now;
  }

  // ───────────────────────── workers & leases ─────────────────────────

  async authenticateWorker(token: string): Promise<WorkerRec> {
    const hash = sha256Hex(token);
    const found = await this.store.query<WorkerRec>(C.workers, [{ field: "tokenHash", eq: hash }], { limit: 2 });
    if (found.length !== 1 || found[0].disabled) throw new AuthorityError("unknown or disabled worker");
    return found[0];
  }

  /** Operator action: create a worker identity with the capabilities it is allowed to serve. */
  async createWorker(id: string, allowedCapabilities: string[]): Promise<string> {
    if (!WORKER_ID.test(id)) throw new Error("worker id must match [a-z0-9][a-z0-9_-]{0,62}");
    const token = `bci_w_${randomUUID().replace(/-/g, "")}${randomUUID().replace(/-/g, "")}`;
    await this.store.transact(`worker-create:${id}:${sha256Hex(token)}`, [{ collection: C.workers, id, requireAbsent: true, value: {
      tokenHash: sha256Hex(token), allowedCapabilities: [...allowedCapabilities].sort(), capabilities: [], resources: {},
      registeredAt: null, lastHeartbeatAt: null, disabled: false,
    } }]);
    return token;
  }

  /**
   * Operator action used by deployment: create the worker identity if absent (returns its token),
   * otherwise set its granted capabilities; with rotate, issue a new token (old one stops working).
   */
  async ensureWorker(id: string, allowedCapabilities: string[], rotate = false): Promise<string | null> {
    if (!WORKER_ID.test(id)) throw new Error("worker id must match [a-z0-9][a-z0-9_-]{0,62}");
    const existing = await this.store.get<WorkerRec>(C.workers, id);
    if (!existing) return this.createWorker(id, allowedCapabilities);
    const token = rotate ? `bci_w_${randomUUID().replace(/-/g, "")}${randomUUID().replace(/-/g, "")}` : null;
    await this.#casLoop<WorkerRec>(C.workers, id, (w) => ({ ...w, allowedCapabilities: [...allowedCapabilities].sort(), disabled: false, ...(token ? { tokenHash: sha256Hex(token) } : {}) }));
    return token;
  }

  /** Workers advertise capabilities; the effective set is intersected with what the operator granted. */
  async registerWorker(w: WorkerRec, advertised: string[], resources: Record<string, unknown>): Promise<string[]> {
    const effective = advertised.filter((c) => w.allowedCapabilities.includes(c)).sort();
    const now = this.now();
    await this.#casLoop(C.workers, w.id, (cur) => ({ ...cur, capabilities: effective, resources, registeredAt: now, lastHeartbeatAt: now }));
    return effective;
  }

  /** Atomically claim the oldest eligible queued job. Returns null if nothing is eligible. */
  async lease(w: WorkerRec): Promise<LeaseGrant | null> {
    const caps = new Set(w.capabilities);
    const queued = await this.store.query<JobRec>(C.jobs, [{ field: "state", eq: "queued" }], { limit: 200, orderBy: [{ field: "queuedAt", direction: "asc" }] });
    for (const j of queued) {
      if (!j.spec.requires.every((c) => caps.has(c))) continue;
      if ((j.spec.permissions.release || j.spec.permissions.deploy) && !j.trusted) continue; // defense in depth
      const n = j.attempts + 1;
      const attemptId = attemptIdOf(j.id, n);
      const leaseId = randomUUID();
      const now = this.now();
      // Inputs are resolved to exact digests before the lease and recorded on the attempt as evidence.
      let inputs: AttemptInput[];
      try { inputs = await this.#resolveInputs(j); }
      catch (e) { await this.#failUnleasable(j, (e as Error).message); continue; }
      // Secrets are resolved BEFORE the lease: a missing secret fails the job cleanly instead of stranding a lease.
      let secrets: Record<string, string> = {};
      if (j.spec.secrets.length) {
        if (!j.trusted) { await this.#failUnleasable(j, "untrusted job requested secrets"); continue; }
        try { secrets = await this.secrets.resolve(j.repository, j.spec.secrets); }
        catch (e) { await this.#failUnleasable(j, `secret not available: ${(e as Error).message}`); continue; }
      }
      try {
        await this.store.transact(`lease:${leaseId}`, [
          { collection: C.jobs, id: j.id, expectedVersionToken: fenceOf(j), value: { ...body(j), state: "leased", attempts: n, leaseId, leaseExpiresAt: now + this.leaseMs, workerId: w.id, attemptId } },
          { collection: C.attempts, id: attemptId, requireAbsent: true, value: {
            jobId: j.id, runId: j.runId, n, workerId: w.id, leaseId, state: "leased", leasedAt: now, startedAt: null, finishedAt: null,
            exitCode: null, reason: null, resultDigest: null, artifacts: [], image: j.spec.image, imageDigest: j.spec.imageDigest ?? null, inputs, logChunks: 0,
          } },
        ]);
      } catch (e) {
        if (e instanceof PreconditionFailed) continue; // another worker won this job
        throw e;
      }
      const run = await this.store.get<RunRec>(C.runs, j.runId);
      const checkout = isInternal(j.repository) ? null : await this.scm.checkoutAuth(j.repository);
      return {
        attemptId, leaseId, jobId: j.id, runId: j.runId, leaseMs: this.leaseMs, job: j.spec, repository: j.repository, sha: j.sha,
        trusted: j.trusted, checkout, secrets, inputs, provenance: { sourceDigest: run?.sourceDigest ?? null, planDigest: run?.planDigest ?? null, ref: run?.ref ?? null },
      };
    }
    return null;
  }

  async #resolveInputs(j: JobRec): Promise<AttemptInput[]> {
    const out: AttemptInput[] = [];
    for (const inp of j.spec.inputs ?? []) {
      const dep = await this.store.get<JobRec>(C.jobs, jobIdOf(j.runId, inp.job));
      if (!dep || dep.state !== "succeeded" || !dep.attemptId) throw new Error(`input ${inp.artifact}: job ${inp.job} has not succeeded`);
      const att = await this.store.get<AttemptRec>(C.attempts, dep.attemptId);
      const a = att?.artifacts.find((x) => x.name === inp.artifact);
      if (!a) throw new Error(`input ${inp.artifact}: not produced by ${inp.job}`);
      if (!(await this.store.get(C.artifacts, artifactIdOf(a.digest)))) throw new Error(`input ${inp.artifact}: sha256:${a.digest} is not in the artifact store`);
      out.push({ name: a.name, digest: a.digest, size: a.size, fromJob: inp.job, fromAttempt: dep.attemptId });
    }
    return out;
  }

  /** A job whose inputs cannot be resolved can never run correctly: fail it instead of leaving it queued. */
  async #failUnleasable(j: JobRec, reason: string) {
    try {
      await this.store.transact(`unleasable:${j.id}:${j.__version}`, [{ collection: C.jobs, id: j.id, expectedVersionToken: fenceOf(j), value: { ...body(j), state: "failed", finishedAt: this.now(), reason } }]);
      await this.advance(j.runId);
    } catch (e) { if (!(e instanceof PreconditionFailed)) throw e; }
  }

  /** The digest of an input the worker's current lease is entitled to read. */
  async inputFor(workerId: string, attemptId: string, leaseId: string, name: string): Promise<AttemptInput> {
    const cur = await this.#currentLease(attemptId, leaseId, workerId);
    if (!cur) throw new AuthorityError("lease is not current");
    const inp = ((cur.attempt as any).inputs as AttemptInput[] | undefined)?.find((i) => i.name === name);
    if (!inp) throw new NotFound(`attempt has no input ${name}`);
    return inp;
  }

  /** Everything recorded about a run: intent, compiled plan, trigger, attempts, artifacts, approvals, statuses. */
  async evidence(runId: string): Promise<Record<string, unknown>> {
    const run = await this.store.get<RunRec>(C.runs, runId);
    if (!run) throw new NotFound(runId);
    const event = await this.store.get(C.events, run.eventId);
    const def = run.sourceDigest ? await this.store.get(C.defs, defIdOf(run.sourceDigest)) : null;
    const jobs = await this.store.query<JobRec>(C.jobs, [{ field: "runId", eq: runId }], { limit: 1000 });
    const attempts = await this.store.query<AttemptRec>(C.attempts, [{ field: "runId", eq: runId }], { limit: 1000 });
    const strip = <T extends Rec>(r: T) => body(r);
    return {
      run: strip(run),
      trigger: event ? { kind: event.kind, ref: event.ref, sha: event.sha, actor: event.actor, provider: event.provider, deliveryId: event.deliveryId, receivedAt: event.receivedAt, trusted: event.trusted } : null,
      definition: def ? { path: def.path, sha256: run.sourceDigest, source: def.source } : null,
      jobs: jobs.sort((a, b) => (a.key < b.key ? -1 : 1)).map((j) => ({
        key: j.key, name: j.spec.name, state: j.state, reason: j.reason, capabilities: j.spec.capabilities ?? [], image: j.spec.image, imageDigest: j.spec.imageDigest ?? null,
        needs: j.spec.needs, approval: j.spec.approval, permissions: j.spec.permissions,
        attempts: attempts.filter((a) => a.jobId === j.id).sort((a, b) => a.n - b.n).map((a) => ({ id: a.id, n: a.n, worker: a.workerId, state: a.state, exitCode: a.exitCode, reason: a.reason, startedAt: a.startedAt, finishedAt: a.finishedAt, inputs: (a as any).inputs ?? [], artifacts: a.artifacts, logChunks: a.logChunks })),
      })),
      approvals: (await this.store.query(C.approvals, [{ field: "runId", eq: runId }], { limit: 100 })).map(strip),
      statuses: (await this.store.query(C.outbox, [{ field: "runId", eq: runId }], { limit: 1000, orderBy: [{ field: "createdAt", direction: "asc" }] })).map((o: any) => ({ context: o.context, state: o.state, delivered: o.delivered, attempts: o.attempts, lastError: o.lastError ?? null })),
    };
  }

  async #currentLease(attemptId: string, leaseId: string, workerId: string): Promise<{ job: JobRec; attempt: AttemptRec } | null> {
    const attempt = await this.store.get<AttemptRec>(C.attempts, attemptId);
    if (!attempt) throw new NotFound(attemptId);
    if (attempt.workerId !== workerId) throw new AuthorityError("attempt belongs to another worker");
    const job = await this.store.get<JobRec>(C.jobs, attempt.jobId);
    if (!job || job.leaseId !== leaseId || job.attemptId !== attemptId || !ACTIVE.has(job.state)) return null;
    return { job, attempt };
  }

  async start(workerId: string, attemptId: string, leaseId: string): Promise<{ ok: boolean; cancel: boolean }> {
    const cur = await this.#currentLease(attemptId, leaseId, workerId);
    if (!cur) return { ok: false, cancel: true };
    if (cur.job.state === "running") return { ok: true, cancel: cur.job.cancelRequested };
    const now = this.now();
    try {
      await this.store.transact(`start:${attemptId}:${leaseId}`, [
        { collection: C.jobs, id: cur.job.id, expectedVersionToken: fenceOf(cur.job), value: { ...body(cur.job), state: "running", startedAt: now, leaseExpiresAt: now + this.leaseMs } },
        { collection: C.attempts, id: attemptId, expectedVersionToken: fenceOf(cur.attempt), value: { ...body(cur.attempt), state: "running", startedAt: now } },
      ]);
    } catch (e) { if (!(e instanceof PreconditionFailed)) throw e; return this.start(workerId, attemptId, leaseId); }
    return { ok: true, cancel: cur.job.cancelRequested };
  }

  /** Extend a lease. `ok:false` means the lease is gone and the worker must abandon the attempt. */
  async heartbeat(workerId: string, attemptId: string, leaseId: string): Promise<{ ok: boolean; cancel: boolean }> {
    for (let i = 0; i < 5; i++) {
      const cur = await this.#currentLease(attemptId, leaseId, workerId);
      if (!cur) return { ok: false, cancel: true };
      try {
        await this.store.transact(`hb:${randomUUID()}`, [{ collection: C.jobs, id: cur.job.id, expectedVersionToken: fenceOf(cur.job), value: { ...body(cur.job), leaseExpiresAt: this.now() + this.leaseMs } }]);
        await this.#touchWorker(workerId);
        return { ok: true, cancel: cur.job.cancelRequested };
      } catch (e) { if (!(e instanceof PreconditionFailed)) throw e; }
    }
    return { ok: true, cancel: false };
  }

  async #touchWorker(workerId: string) {
    try { await this.#casLoop(C.workers, workerId, (w) => ({ ...w, lastHeartbeatAt: this.now() }), 1); } catch { /* best effort */ }
  }

  /** Append a log chunk. Idempotent per (attempt, seq). Chunks are bounded below FeltDB's 1 MiB request limit. */
  async appendLog(workerId: string, attemptId: string, seq: number, data: string): Promise<void> {
    if (Buffer.byteLength(data) > 256 * 1024) throw new Error("log chunk exceeds 256 KiB");
    const attempt = await this.store.get<AttemptRec>(C.attempts, attemptId);
    if (!attempt) throw new NotFound(attemptId);
    if (attempt.workerId !== workerId) throw new AuthorityError("attempt belongs to another worker");
    if (!Number.isInteger(seq) || seq < 0) throw new Error("invalid log sequence");
    const id = `${attemptId}-${String(seq).padStart(8, "0")}`;
    try {
      await this.store.transact(`log:${id}:${sha256Hex(data)}`, [{ collection: C.logs, id, requireAbsent: true, value: { attemptId, seq, data, at: this.now() } }]);
    } catch (e) {
      if (!(e instanceof PreconditionFailed)) throw e;
      const prev = await this.store.get(C.logs, id);
      if (prev?.data !== data) throw new Conflict(`log chunk ${seq} already recorded with different content`);
    }
  }

  async readLog(attemptId: string): Promise<string> {
    const chunks = await this.store.query(C.logs, [{ field: "attemptId", eq: attemptId }], { limit: 100000, orderBy: [{ field: "seq", direction: "asc" }] });
    return chunks.map((c) => c.data as string).join("");
  }

  /**
   * Submit an attempt's result. Idempotent: resubmitting the identical result is acknowledged;
   * a different result for an already-terminal attempt is a conflict. Results for a lease that has
   * expired are recorded on the attempt as evidence but do not change the job.
   */
  async complete(workerId: string, attemptId: string, leaseId: string, r: AttemptResult): Promise<{ accepted: boolean; duplicate: boolean; jobState: JobState | null }> {
    const resultDigest = sha256Hex(canonicalJson(r));
    for (let i = 0; i < 8; i++) {
      const attempt = await this.store.get<AttemptRec>(C.attempts, attemptId);
      if (!attempt) throw new NotFound(attemptId);
      if (attempt.workerId !== workerId || attempt.leaseId !== leaseId) throw new AuthorityError("attempt/lease mismatch");
      if (attempt.resultDigest) {
        if (attempt.resultDigest === resultDigest) {
          const j = await this.store.get<JobRec>(C.jobs, attempt.jobId);
          return { accepted: true, duplicate: true, jobState: j?.state ?? null };
        }
        throw new Conflict("attempt already has a different result");
      }
      const job = await this.store.get<JobRec>(C.jobs, attempt.jobId);
      if (!job) throw new NotFound(attempt.jobId);
      const now = this.now();
      const verified = await this.#verifyArtifacts(r.artifacts);
      const outcome = r.outcome === "succeeded" && !verified ? "failed" : r.outcome;
      const reason = r.outcome === "succeeded" && !verified ? "declared artifact missing from store or digest mismatch" : r.reason ?? null;
      const attemptState = outcome === "succeeded" ? "succeeded" : outcome === "cancelled" ? "cancelled" : r.timedOut ? "timed_out" : "failed";
      const isCurrent = job.attemptId === attemptId && job.leaseId === leaseId && ACTIVE.has(job.state);
      const ops: TxOp[] = [{ collection: C.attempts, id: attemptId, expectedVersionToken: fenceOf(attempt), value: {
        ...body(attempt), state: isCurrent ? attemptState : `late_${attemptState}`, finishedAt: now, exitCode: r.exitCode ?? null, reason,
        resultDigest, artifacts: r.artifacts ?? [], logChunks: r.logChunks ?? attempt.logChunks,
      } }];
      let jobState: JobState = job.state;
      if (isCurrent) {
        const retryClass = r.timedOut ? "timeout" : outcome === "failed" ? "failure" : null;
        const retry = !job.cancelRequested && retryClass && job.spec.retry.on.includes(retryClass) && job.attempts < job.spec.retry.maxAttempts;
        jobState = job.cancelRequested && outcome !== "succeeded" ? "cancelled" : outcome === "succeeded" ? "succeeded" : retry ? "queued" : outcome === "cancelled" ? "cancelled" : "failed";
        ops.push({ collection: C.jobs, id: job.id, expectedVersionToken: fenceOf(job), value: {
          ...body(job), state: jobState, leaseId: null, leaseExpiresAt: null, workerId: null,
          queuedAt: jobState === "queued" ? now : job.queuedAt, finishedAt: TERMINAL.has(jobState) ? now : null, reason: jobState === "queued" ? `retry after ${attemptState}` : reason,
        } });
        for (const a of verified ? r.artifacts ?? [] : []) {
          ops.push({ collection: C.artifactRefs, id: `${attemptId}-${sha256Hex(a.name).slice(0, 12)}`, requireAbsent: true, value: {
            attemptId, jobId: job.id, runId: job.runId, repository: job.repository, sha: job.sha, name: a.name, digest: a.digest, size: a.size,
            image: job.spec.image, retentionUntil: now + (job.spec.artifacts.find((x) => x.name === a.name)?.retentionDays ?? 30) * 86_400_000, createdAt: now,
          } });
        }
        if (TERMINAL.has(jobState)) {
          const st: CommitState = jobState === "succeeded" ? "success" : jobState === "cancelled" ? "error" : "failure";
          pushOp(ops, this.#statusOp(job.runId, job.repository, job.sha, jobCtx(prefixOf(job), job.key), st, `${jobState}${reason ? `: ${reason}` : ""}`, `${job.id}:final`));
        }
      }
      let duplicate = false;
      try {
        duplicate = (await this.store.transact(`complete:${attemptId}:${resultDigest}`, ops)).duplicate;
      } catch (e) { if (e instanceof PreconditionFailed) continue; throw e; }
      if (isCurrent) await this.advance(job.runId);
      return { accepted: isCurrent, duplicate, jobState: isCurrent ? jobState : null };
    }
    throw new Conflict("complete did not converge");
  }

  async #verifyArtifacts(arts: AttemptResult["artifacts"]): Promise<boolean> {
    for (const a of arts ?? []) {
      if (!/^[0-9a-f]{64}$/.test(a.digest)) return false;
      const rec = await this.store.get(C.artifacts, artifactIdOf(a.digest));
      if (!rec || rec.size !== a.size) return false;
    }
    return true;
  }

  // ───────────────────────── recovery ─────────────────────────

  /** Expire lost leases and enforce timeouts. Run periodically; idempotent and restart-safe. */
  async reap(): Promise<{ expired: number; timedOut: number }> {
    const now = this.now();
    let expired = 0, timedOut = 0;
    const active = [
      ...(await this.store.query<JobRec>(C.jobs, [{ field: "state", eq: "leased" }], { limit: 1000 })),
      ...(await this.store.query<JobRec>(C.jobs, [{ field: "state", eq: "running" }], { limit: 1000 })),
    ];
    for (const j of active) {
      const lost = (j.leaseExpiresAt ?? 0) < now;
      const overTime = j.startedAt !== null && now > j.startedAt + j.spec.timeoutMinutes * 60_000 + this.leaseMs;
      if (!lost && !overTime) continue;
      const attempt = j.attemptId ? await this.store.get<AttemptRec>(C.attempts, j.attemptId) : null;
      const cls = overTime ? "timeout" : "infrastructure";
      const retry = !j.cancelRequested && j.spec.retry.on.includes(cls) && j.attempts < j.spec.retry.maxAttempts;
      const next: JobState = j.cancelRequested ? "cancelled" : retry ? "queued" : "failed";
      const reason = overTime ? `timed out after ${j.spec.timeoutMinutes}m` : `lease expired (worker ${j.workerId} lost)`;
      const ops: TxOp[] = [{ collection: C.jobs, id: j.id, expectedVersionToken: fenceOf(j), value: {
        ...body(j), state: next, leaseId: null, leaseExpiresAt: null, workerId: null, queuedAt: next === "queued" ? now : j.queuedAt,
        finishedAt: TERMINAL.has(next) ? now : null, reason: next === "queued" ? `retry: ${reason}` : reason,
      } }];
      if (attempt && !attempt.resultDigest) ops.push({ collection: C.attempts, id: attempt.id, expectedVersionToken: fenceOf(attempt), value: { ...body(attempt), state: overTime ? "timed_out" : "lost", finishedAt: now, reason } });
      if (TERMINAL.has(next)) pushOp(ops, this.#statusOp(j.runId, j.repository, j.sha, jobCtx(prefixOf(j), j.key), next === "cancelled" ? "error" : "failure", reason, `${j.id}:final`));
      try {
        await this.store.transact(`reap:${j.id}:${j.__version}`, ops);
        overTime ? timedOut++ : expired++;
        await this.advance(j.runId);
      } catch (e) { if (!(e instanceof PreconditionFailed)) throw e; }
    }
    return { expired, timedOut };
  }

  // ───────────────────────── operator actions ─────────────────────────

  async cancelRun(runId: string, by: string): Promise<void> {
    await this.#casLoop<RunRec>(C.runs, runId, (r) => (r.state === "running" ? { ...r, cancelRequested: true, reason: `cancelled by ${by}` } : r));
    const jobs = await this.store.query<JobRec>(C.jobs, [{ field: "runId", eq: runId }], { limit: 1000 });
    for (const j of jobs) {
      if (TERMINAL.has(j.state)) continue;
      await this.#casLoop<JobRec>(C.jobs, j.id, (cur) => {
        if (TERMINAL.has(cur.state)) return cur;
        if (ACTIVE.has(cur.state)) return { ...cur, cancelRequested: true };
        return { ...cur, state: "cancelled", reason: `cancelled by ${by}`, finishedAt: this.now() };
      });
    }
    await this.advance(runId);
  }

  async approve(jobId: string, approver: string): Promise<void> {
    const j = await this.store.get<JobRec>(C.jobs, jobId);
    if (!j) throw new NotFound(jobId);
    if (j.state !== "awaiting_approval") throw new Conflict(`job is ${j.state}`);
    if (j.spec.approval.approvers.length && !j.spec.approval.approvers.includes(approver)) throw new AuthorityError(`${approver} may not approve ${j.key}`);
    if (!j.trusted) throw new AuthorityError("untrusted runs cannot be approved");
    await this.store.transact(`approve:${jobId}:${j.__version}`, [
      { collection: C.jobs, id: jobId, expectedVersionToken: fenceOf(j), value: { ...body(j), state: "queued", queuedAt: this.now() } },
      { collection: C.approvals, id: `${jobId}-${sha256Hex(approver).slice(0, 12)}`, requireAbsent: true, value: { jobId, runId: j.runId, approver, at: this.now(), planDigestAtApproval: (await this.store.get<RunRec>(C.runs, j.runId))?.planDigest } },
    ]);
  }

  /** Report pending commit statuses. Durable outbox: survives crashes, retried until delivered. */
  async deliverStatuses(limit = 100): Promise<number> {
    const pending = await this.store.query(C.outbox, [{ field: "delivered", eq: false }], { limit, orderBy: [{ field: "createdAt", direction: "asc" }] });
    // Only the newest status per (repository, sha, context) is delivered; older ones are superseded,
    // so a retried stale "pending" can never overwrite a final state.
    const newest = new Map<string, Rec>();
    const rank = (o: Rec) => [o.state === "pending" ? 0 : 1, o.createdAt as number];
    const newer = (a: Rec, b: Rec) => { const [x, y] = [rank(a), rank(b)]; return x[0] !== y[0] ? x[0] > y[0] : x[1] >= y[1]; };
    for (const o of pending) {
      const k = `${o.repository}\0${o.sha}\0${o.context}`;
      const cur = newest.get(k);
      if (!cur || newer(o, cur)) newest.set(k, o);
    }
    for (const o of pending) {
      if (newest.get(`${o.repository}\0${o.sha}\0${o.context}`) === o) continue;
      await this.store.transact(`ob-sup:${o.id}`, [{ collection: C.outbox, id: o.id, expectedVersionToken: fenceOf(o), value: { ...body(o), delivered: true, superseded: true } }]).catch(() => {});
    }
    let n = 0;
    for (const o of newest.values()) {
      try {
        await this.scm.reportStatus(o.repository as string, o.sha as string, { context: o.context as string, state: o.state as CommitState, description: o.description as string, targetUrl: (o.targetUrl as string) ?? undefined });
        await this.store.transact(`ob-done:${o.id}`, [{ collection: C.outbox, id: o.id, expectedVersionToken: fenceOf(o), value: { ...body(o), delivered: true, deliveredAt: this.now() } }]).catch(() => {});
        n++;
      } catch (e) {
        await this.store.transact(`ob-fail:${o.id}:${o.__version}`, [{ collection: C.outbox, id: o.id, expectedVersionToken: fenceOf(o), value: { ...body(o), attempts: (o.attempts as number) + 1, lastError: String((e as Error).message).slice(0, 300) } }]).catch(() => {});
      }
    }
    return n;
  }

  // ───────────────────────── health (deployment verification) ─────────────────────────

  /**
   * Create a canary run: a real job that must be leased by a real worker, executed in the real
   * executor, upload a real artifact and complete. No source provider is involved.
   */
  async createCanary(image: string, requires: string[] = ["linux-small"]): Promise<string> {
    const source = canarySpec(image, requires);
    const r = await this.intake({ provider: "boundry", deliveryId: `canary:${randomUUID()}`, kind: "manual", repository: `${INTERNAL_OWNER}/canary`, ref: "refs/heads/canary", sha: "0".repeat(40), trusted: true, actor: "deploy-verifier" }, { source });
    if (!r.runId) throw new Error(`canary not created: ${r.state}`);
    return r.runId;
  }

  /** Write, read back and delete a probe record; confirm every CI collection is queryable. */
  async probeStore(): Promise<{ writeReadDeleteMs: number; collections: Record<string, boolean> }> {
    const id = `probe-${randomUUID()}`;
    const nonce = randomUUID();
    const t = performance.now();
    await this.store.transact(`probe-w:${id}`, [{ collection: "ci_health", id, requireAbsent: true, value: { nonce, at: this.now() } }]);
    const back = await this.store.get("ci_health", id);
    if (back?.nonce !== nonce) throw new Error("FeltDB probe read-back mismatch");
    await this.store.transact(`probe-d:${id}`, [{ collection: "ci_health", id, expectedVersionToken: fenceOf(back) }]);
    if (await this.store.get("ci_health", id)) throw new Error("FeltDB probe delete not visible");
    const ms = performance.now() - t;
    const collections: Record<string, boolean> = {};
    for (const c of Object.values(C)) {
      try { await this.store.query(c, [], { limit: 1 }); collections[c] = true; } catch { collections[c] = false; }
    }
    return { writeReadDeleteMs: +ms.toFixed(1), collections };
  }

  // ───────────────────────── scheduled pipelines ─────────────────────────

  async #registerSchedules(ev: SourceEvent, schedules: { cron: string; branch: string }[]) {
    const branch = ev.ref.slice("refs/heads/".length);
    for (const s of schedules) {
      if (s.branch !== branch) continue;
      const id = stableId("sched", ev.repository, s.cron, branch);
      if (await this.store.get(C.schedules, id)) continue;
      await this.store.transact(`sched:${id}`, [{ collection: C.schedules, id, requireAbsent: true, value: {
        repository: ev.repository, branch, cron: s.cron, nextFireAt: nextFire(s.cron, this.now()), lastFiredAt: null, enabled: true,
      } }]).catch((e) => { if (!(e instanceof PreconditionFailed)) throw e; });
    }
  }

  /**
   * Fire due schedules. The event id is derived from (schedule, slot) so a fire is created at
   * most once even across crashes; missed slots while down coalesce into one catch-up run.
   */
  async tickSchedules(): Promise<number> {
    const now = this.now();
    const due = await this.store.query(C.schedules, [{ field: "nextFireAt", lte: now }, { field: "enabled", eq: true }], { limit: 200 });
    let fired = 0;
    for (const s of due) {
      const slot = s.nextFireAt as number;
      const sha = await this.scm.resolveBranch(s.repository as string, s.branch as string);
      if (sha) {
        await this.intake({ provider: "boundry", deliveryId: `schedule:${s.id}:${slot}`, kind: "schedule", repository: s.repository as string, ref: `refs/heads/${s.branch}`, sha, trusted: true, cron: s.cron as string, actor: "scheduler" });
        fired++;
      }
      await this.store.transact(`sched-adv:${s.id}:${slot}`, [{ collection: C.schedules, id: s.id, expectedVersionToken: fenceOf(s), value: { ...body(s), lastFiredAt: slot, nextFireAt: nextFire(s.cron as string, Math.max(now, slot)) } }]).catch((e) => { if (!(e instanceof PreconditionFailed)) throw e; });
    }
    return fired;
  }

  async #casLoop<T extends Rec>(collection: string, id: string, f: (cur: T) => T, tries = 8): Promise<T> {
    for (let i = 0; i < tries; i++) {
      const cur = await this.store.get<T>(collection, id);
      if (!cur) throw new NotFound(`${collection}/${id}`);
      const next = f(cur);
      if (next === cur) return cur;
      try {
        await this.store.transact(`cas:${collection}:${id}:${cur.__version}:${randomUUID()}`, [{ collection, id, expectedVersionToken: fenceOf(cur), value: body(next as Rec) }]);
        return next;
      } catch (e) { if (!(e instanceof PreconditionFailed)) throw e; }
    }
    throw new Conflict(`${collection}/${id}: too much contention`);
  }
}

export interface LeaseGrant {
  attemptId: string; leaseId: string; jobId: string; runId: string; leaseMs: number; job: PlanJob;
  repository: string; sha: string; trusted: boolean; checkout: { url: string; header?: string } | null;
  secrets: Record<string, string>; inputs: AttemptInput[]; provenance: { sourceDigest: string | null; planDigest: string | null; ref: string | null };
}
export interface AttemptInput { name: string; digest: string; size: number; fromJob: string; fromAttempt: string }

export interface AttemptResult {
  outcome: "succeeded" | "failed" | "cancelled";
  exitCode?: number | null;
  reason?: string | null;
  timedOut?: boolean;
  logChunks?: number;
  artifacts?: { name: string; digest: string; size: number }[];
}

/** The canary pipeline. Exercises: lease, executor isolation (non-root, no network), logs, artifact upload. */
export function canarySpec(image: string, requires: string[]): string {
  return [
    "version: 1",
    "name: boundry-ci-canary",
    "on: { manual: {} }",
    "jobs:",
    "  canary:",
    `    image: "${image}"`,
    `    requires: [${requires.join(", ")}]`,
    "    network: none",
    "    timeout_minutes: 3",
    "    resources: { cpus: 0.5, memory_mb: 256, disk_mb: 64, pids: 64 }",
    "    steps:",
    "      - name: isolation",
    "        run: |",
    "          test \"$(id -u)\" != 0",
    "          echo \"uid=$(id -u)\"",
    "      - name: artifact",
    "        run: |",
    "          printf 'boundry-ci canary\\n' > canary.txt",
    "    artifacts: [{ name: canary.txt, path: canary.txt, retention_days: 1 }]",
    "",
  ].join("\n");
}
