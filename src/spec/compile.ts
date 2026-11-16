// Deterministic compiler: .boundry/ci.yaml source + event context -> execution plan.
// The same (source bytes, context) always yields byte-identical plan JSON and digest.
import { createRequire } from "node:module";
import YAML from "yaml";
import { canonicalJson, sha256Hex } from "../canonical.ts";

const require = createRequire(import.meta.url);
const AjvCtor = require("ajv");
const schema = require("../../schema/ci.v1.schema.json");
const ajv = new (AjvCtor.default ?? AjvCtor)({ allErrors: true, strict: true, allowUnionTypes: true });
const validateSchema = ajv.compile(schema);

export const SPEC_PATH = ".boundry/ci.yaml";
export const COMPILER_VERSION = "boundry-ci-compiler/1";

export type EventKind = "push" | "pull_request" | "tag" | "release" | "schedule" | "manual" | "upstream";

export interface CompileContext {
  repository: string; // owner/name
  kind: EventKind;
  ref: string; // refs/heads/x or refs/tags/x or refs/pull/N/head
  sha: string;
  /** False for pull requests from forks and any other source the platform does not trust. */
  trusted: boolean;
  /** For schedule events: the cron expression that fired. */
  cron?: string;
  /** Base branch for pull requests. */
  baseBranch?: string;
}

export interface PlanJob {
  key: string; // unique within run, e.g. "test[node=22]"
  job: string; // job id in the source
  name: string;
  matrix: Record<string, string | number | boolean>;
  image: string;
  requires: string[];
  needs: string[]; // plan job keys
  network: "none" | "egress";
  resources: { cpus: number; memoryMb: number; diskMb: number; pids: number };
  timeoutMinutes: number;
  retry: { maxAttempts: number; on: string[] };
  env: Record<string, string>;
  secrets: string[];
  permissions: { release: boolean; deploy: boolean };
  approval: { required: boolean; approvers: string[] };
  cache: { name: string; path: string; keyFiles: string[] }[];
  artifacts: { name: string; path: string; retentionDays: number }[];
  steps: { name: string; run: string }[];
}

export interface Plan {
  compiler: string;
  pipeline: string;
  sourceDigest: string;
  context: CompileContext;
  concurrency: { group: string; cancelInProgress: boolean } | null;
  downstream: { repository: string; ref: string | null }[];
  jobs: PlanJob[];
}

export interface CompileResult {
  plan: Plan;
  planDigest: string;
}

export class SpecError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`invalid ${SPEC_PATH}: ${problems.join("; ")}`);
    this.problems = problems;
  }
}

const DEFAULTS = {
  requires: ["linux-small"],
  network: "none" as const,
  resources: { cpus: 2, memory_mb: 2048, disk_mb: 4096, pids: 1024 },
  timeout_minutes: 30,
  retry: { max_attempts: 1, on: ["infrastructure"] },
  artifactRetentionDays: 30,
};

export function parseSpec(source: string): any {
  let doc: unknown;
  try {
    // YAML 1.2 core schema: "on"/"yes" are strings, never booleans.
    doc = YAML.parse(source, { version: "1.2", uniqueKeys: true, maxAliasCount: 50 });
  } catch (e) {
    throw new SpecError([`YAML: ${(e as Error).message.split("\n")[0]}`]);
  }
  if (!validateSchema(doc)) {
    throw new SpecError((validateSchema.errors ?? []).map((e: any) => `${e.instancePath || "/"} ${e.message}`));
  }
  return doc;
}

export function compile(source: string, ctx: CompileContext): CompileResult {
  const sourceDigest = sha256Hex(source);
  const spec = parseSpec(source);
  const problems: string[] = [];

  // Resolve job fields: defaults <- template <- job (env merged key-wise).
  const resolved = new Map<string, any>();
  for (const id of Object.keys(spec.jobs).sort()) {
    const job = spec.jobs[id];
    const tpl = job.extends ? spec.templates?.[job.extends] : undefined;
    if (job.extends && !tpl) problems.push(`jobs.${id}.extends: unknown template '${job.extends}'`);
    if (tpl?.extends) problems.push(`templates.${job.extends}: templates cannot extend templates`);
    const layers = [spec.defaults ?? {}, tpl ?? {}, job];
    const merged: any = {};
    for (const layer of layers) {
      for (const [k, v] of Object.entries(layer)) {
        if (k === "extends") continue;
        merged[k] = k === "env" ? { ...(merged.env ?? {}), ...(v as object) } : v;
      }
    }
    if (!merged.image) problems.push(`jobs.${id}: image is required (directly, via defaults, or via template)`);
    if (!merged.steps) problems.push(`jobs.${id}: steps are required`);
    resolved.set(id, merged);
  }

  // Graph checks on source job ids.
  for (const [id, job] of resolved) {
    for (const dep of job.needs ?? []) {
      if (!resolved.has(dep)) problems.push(`jobs.${id}.needs: unknown job '${dep}'`);
      if (dep === id) problems.push(`jobs.${id}.needs: job cannot depend on itself`);
    }
  }
  const cycle = findCycle(resolved);
  if (cycle) problems.push(`dependency cycle: ${cycle.join(" -> ")}`);

  // Authority rules that must hold regardless of event.
  for (const [id, job] of resolved) {
    const requires: string[] = job.requires ?? DEFAULTS.requires;
    if (job.permissions?.release) {
      if (!requires.includes("release")) problems.push(`jobs.${id}: permissions.release requires capability 'release'`);
      if (!/@sha256:[0-9a-f]{64}$/.test(job.image ?? "")) problems.push(`jobs.${id}: release jobs must pin image by @sha256 digest`);
    }
    if (job.permissions?.deploy) {
      if (!requires.includes("deploy")) problems.push(`jobs.${id}: permissions.deploy requires capability 'deploy'`);
      if (!/@sha256:[0-9a-f]{64}$/.test(job.image ?? "")) problems.push(`jobs.${id}: deploy jobs must pin image by @sha256 digest`);
    }
    if ((requires.includes("release") || requires.includes("deploy")) && !(job.permissions?.release || job.permissions?.deploy)) {
      problems.push(`jobs.${id}: capability release/deploy requires the matching explicit permission`);
    }
  }
  if (problems.length) throw new SpecError(problems);

  // Event selection: the pipeline must subscribe to the event, then each job's `when` filters.
  const pipelineName = spec.name ?? ctx.repository;
  if (!pipelineAccepts(spec.on ?? {}, ctx)) {
    return finish({ compiler: COMPILER_VERSION, pipeline: pipelineName, sourceDigest, context: ctx, concurrency: null, downstream: [], jobs: [] });
  }

  const selected = new Set<string>();
  for (const id of topoOrder(resolved)) {
    const job = resolved.get(id);
    const depsSelected = (job.needs ?? []).every((d: string) => selected.has(d));
    if (depsSelected && whenMatches(job.when, ctx)) selected.add(id);
  }

  // Matrix expansion (deterministic: keys sorted, value order preserved).
  const expansions = new Map<string, PlanJob[]>();
  for (const id of [...selected].sort()) {
    const job = resolved.get(id);
    const combos = expandMatrix(job.matrix ?? {});
    if (combos.length > 64) throw new SpecError([`jobs.${id}: matrix expands to ${combos.length} jobs (max 64)`]);
    expansions.set(id, combos.map((m) => toPlanJob(id, job, m)));
  }
  for (const [, list] of expansions) {
    for (const pj of list) {
      pj.needs = pj.needs.flatMap((dep) => expansions.get(dep)!.map((d) => d.key)).sort();
    }
  }

  const jobs = [...expansions.values()].flat().sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const concurrency = spec.concurrency
    ? { group: substitute(spec.concurrency.group, ctx, pipelineName), cancelInProgress: spec.concurrency.cancel_in_progress ?? false }
    : null;
  const downstream = (spec.downstream ?? [])
    .filter((d: any) => whenMatches(d.when, ctx))
    .map((d: any) => ({ repository: d.repository, ref: d.ref ?? null }));

  return finish({ compiler: COMPILER_VERSION, pipeline: pipelineName, sourceDigest, context: ctx, concurrency, downstream, jobs });
}

function finish(plan: Plan): CompileResult {
  return { plan, planDigest: sha256Hex(canonicalJson(plan)) };
}

function toPlanJob(id: string, job: any, matrix: Record<string, any>): PlanJob {
  const mkeys = Object.keys(matrix).sort();
  const key = mkeys.length ? `${id}[${mkeys.map((k) => `${k}=${matrix[k]}`).join(",")}]` : id;
  const res = { ...DEFAULTS.resources, ...(job.resources ?? {}) };
  const env: Record<string, string> = {};
  for (const k of Object.keys(job.env ?? {}).sort()) env[k] = expandMatrixVars(job.env[k], matrix);
  for (const k of mkeys) env[`MATRIX_${k.toUpperCase().replace(/-/g, "_")}`] = String(matrix[k]);
  return {
    key,
    job: id,
    name: expandMatrixVars(job.name ?? id, matrix),
    matrix,
    image: expandMatrixVars(job.image, matrix),
    requires: [...(job.requires ?? DEFAULTS.requires)].sort(),
    needs: [...(job.needs ?? [])],
    network: job.network ?? DEFAULTS.network,
    resources: { cpus: res.cpus, memoryMb: res.memory_mb, diskMb: res.disk_mb, pids: res.pids },
    timeoutMinutes: job.timeout_minutes ?? DEFAULTS.timeout_minutes,
    retry: { maxAttempts: job.retry?.max_attempts ?? DEFAULTS.retry.max_attempts, on: [...(job.retry?.on ?? DEFAULTS.retry.on)].sort() },
    env,
    secrets: [...(job.secrets ?? [])].sort(),
    permissions: { release: !!job.permissions?.release, deploy: !!job.permissions?.deploy },
    approval: { required: !!job.approval?.required, approvers: [...(job.approval?.approvers ?? [])].sort() },
    cache: (job.cache ?? []).map((c: any) => ({ name: c.name, path: c.path, keyFiles: [...(c.key_files ?? [])].sort() })),
    artifacts: (job.artifacts ?? []).map((a: any) => ({ name: a.name, path: a.path, retentionDays: a.retention_days ?? DEFAULTS.artifactRetentionDays })),
    steps: job.steps.map((s: any, i: number) => ({ name: expandMatrixVars(s.name ?? `step ${i + 1}`, matrix), run: expandMatrixVars(s.run, matrix) })),
  };
}

function expandMatrix(m: Record<string, any[]>): Record<string, any>[] {
  let combos: Record<string, any>[] = [{}];
  for (const k of Object.keys(m).sort()) {
    combos = combos.flatMap((c) => m[k].map((v) => ({ ...c, [k]: v })));
  }
  return combos;
}

function expandMatrixVars(s: string, matrix: Record<string, any>): string {
  return s.replace(/\$\{\{\s*matrix\.([a-z][a-z0-9_-]*)\s*\}\}/g, (all, k) => (k in matrix ? String(matrix[k]) : all));
}

function substitute(tpl: string, ctx: CompileContext, pipeline: string): string {
  const vars: Record<string, string> = { repository: ctx.repository, ref: ctx.ref, pipeline, event: ctx.kind, sha: ctx.sha };
  return tpl.replace(/\$\{([a-z]+)\}/g, (all, k) => vars[k] ?? all);
}

function branchOf(ctx: CompileContext): string | null {
  if (ctx.kind === "pull_request") return ctx.baseBranch ?? null;
  return ctx.ref.startsWith("refs/heads/") ? ctx.ref.slice("refs/heads/".length) : null;
}
function tagOf(ctx: CompileContext): string | null {
  return ctx.ref.startsWith("refs/tags/") ? ctx.ref.slice("refs/tags/".length) : null;
}

export function globMatch(pattern: string, value: string): boolean {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") { re += ".*"; i++; } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`).test(value);
}

const anyGlob = (patterns: string[] | undefined, v: string | null) =>
  !patterns || (v !== null && patterns.some((p) => globMatch(p, v)));

function pipelineAccepts(on: any, ctx: CompileContext): boolean {
  switch (ctx.kind) {
    case "push": return !!on.push && anyGlob(on.push.branches, branchOf(ctx));
    case "pull_request": return !!on.pull_request && anyGlob(on.pull_request.branches, branchOf(ctx));
    case "tag": return !!on.tag && anyGlob(on.tag.patterns, tagOf(ctx));
    case "release": return !!on.release;
    case "manual": return !!on.manual;
    case "upstream": return !!on.upstream;
    case "schedule":
      return (on.schedule ?? []).some((s: any) => s.cron === ctx.cron && (!s.branch || s.branch === branchOf(ctx)));
  }
}

function whenMatches(when: any, ctx: CompileContext): boolean {
  if (!when) return true;
  if (when.events && !when.events.includes(ctx.kind)) return false;
  if (when.branches && !anyGlob(when.branches, branchOf(ctx))) return false;
  if (when.tags && !anyGlob(when.tags, tagOf(ctx))) return false;
  return true;
}

function topoOrder(jobs: Map<string, any>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const visit = (id: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    for (const d of [...(jobs.get(id).needs ?? [])].sort()) visit(d);
    out.push(id);
  };
  for (const id of [...jobs.keys()].sort()) visit(id);
  return out;
}

function findCycle(jobs: Map<string, any>): string[] | null {
  const state = new Map<string, 1 | 2>();
  const stack: string[] = [];
  const dfs = (id: string): string[] | null => {
    state.set(id, 1);
    stack.push(id);
    for (const d of jobs.get(id)?.needs ?? []) {
      if (!jobs.has(d)) continue;
      if (state.get(d) === 1) return [...stack.slice(stack.indexOf(d)), d];
      if (!state.has(d)) { const c = dfs(d); if (c) return c; }
    }
    stack.pop();
    state.set(id, 2);
    return null;
  };
  for (const id of [...jobs.keys()].sort()) if (!state.has(id)) { const c = dfs(id); if (c) return c; }
  return null;
}
