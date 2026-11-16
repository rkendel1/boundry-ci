// Recipe compiler: recipe text + project facts (+ the triggering event) → the engine's execution plan.
// Deterministic: same recipe bytes, compiler version, catalog version and facts ⇒ identical plan and digest.
// It never adds permissions, publishing, deployment or approvals that the recipe did not ask for; anything
// it cannot do is reported as a diagnostic, never approximated.
import { parseRecipe, normalize, type ParsedRecipe, type Line } from "./parse.ts";
import {
  CAPABILITIES, CATALOG_VERSION, VAGUE, VAGUE_SUGGESTIONS, sayOf, capability, matchPhrase, suggest, toolchainFor, isUnsupported, display,
  type Capability, type Toolchain, type Status,
} from "./catalog.ts";
import { gatherFacts, factsDigest, type FileSource, type ProjectFacts, type Ecosystem } from "./facts.ts";
import { canonicalJson, sha256Hex } from "../canonical.ts";
import type { Plan, PlanJob, CompileContext } from "../spec/compile.ts";
import { globMatch } from "../spec/compile.ts";

export const COMPILER_VERSION = "boundry-recipes/1.0.0";
export const RECIPES_DIR = ".boundry/recipes";

export interface Diagnostic { line: number; severity: "error" | "decision" | "unsupported"; message: string; suggestions?: string[] }
export class RecipeError extends Error {
  readonly diagnostics: Diagnostic[];
  readonly path: string;
  constructor(path: string, diagnostics: Diagnostic[]) {
    super(`${path}: ${diagnostics.map((d) => `line ${d.line}: ${d.message}`).join("; ")}`);
    this.path = path; this.diagnostics = diagnostics;
  }
}

export interface Trigger { capability: string; kind: "pull_request" | "push" | "tag" | "manual" | "schedule"; branches?: string[]; cron?: string; scheduleBranch?: string; words: string }
export interface ExplainedJob {
  key: string; order: number; words: string; capability: string; capabilityVersion: string; status: Status; custom: boolean;
  toolchain: string; summary: string; install: boolean; network: boolean; keeps: string[]; inputs: string[];
  approval: string[]; permissions: string[]; secrets: string[]; after: string[];
}
export interface CompiledRecipe {
  path: string; title: string; purpose: string; sourceDigest: string;
  compiler: string; catalog: string; capabilities: Record<string, string>;
  facts: ProjectFacts; factsDigest: string; ecosystem: Ecosystem;
  triggers: Trigger[]; report: boolean; evidence: boolean; retentionDays: Record<string, number>;
  jobs: ExplainedJob[];
  /** Digest of everything that will execute, independent of the triggering commit: the reviewable identity. */
  definitionDigest: string;
  plan: Plan; planDigest: string;
}

const DEFAULT_RETENTION: Record<string, number> = { "build-output.tar": 30, "test-results.txt": 30, "package.tar": 365, "release-manifest.txt": 365 };
const TAR = "tar --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner";

/** Compile a recipe file, reading project facts through `files`. */
export async function compileRecipeSource(source: string, path: string, files: FileSource, ctx: CompileContext | null): Promise<CompiledRecipe> {
  const parsed = parseRecipe(source);
  const project = readProject(parsed);
  const facts = await gatherFacts(files, project.dir);
  return compileParsed(parsed, source, path, facts, project, ctx);
}

interface ProjectSection { dir: string; ecosystem: Ecosystem | null; tool: string | null; outputs: string[]; diags: Diagnostic[]; used: string[] }

function readProject(p: ParsedRecipe): ProjectSection {
  const out: ProjectSection = { dir: ".", ecosystem: null, tool: null, outputs: [], diags: [], used: [] };
  for (const l of p.sections.project ?? []) {
    const m = matchPhrase("project", normalize(l.text));
    if (!m) { out.diags.push({ line: l.line, severity: "error", message: `I don't understand “${l.text}” as a fact about the project`, suggestions: suggest("project", normalize(l.text)) }); continue; }
    out.used.push(m.cap.id);
    if (m.cap.id === "project.dir") out.dir = m.slots[0].replace(/^\.\/|\/$/g, "") || ".";
    if (m.cap.id === "project.ecosystem") out.ecosystem = ({ "node.js": "node", nodejs: "node", node: "node", javascript: "node", typescript: "node", golang: "go" } as Record<string, Ecosystem>)[m.slots[0].toLowerCase()] ?? (m.slots[0].toLowerCase() as Ecosystem);
    if (m.cap.id === "project.tool") out.tool = m.slots[0].toLowerCase();
    if (m.cap.id === "project.output") out.outputs.push(...[...m.slots[0].matchAll(/`([^`]+)`/g)].map((x) => x[1]));
  }
  if (/(^|\/)\.\.(\/|$)/.test(out.dir) || out.dir.startsWith("/")) out.diags.push({ line: 0, severity: "error", message: "the project directory must be inside the repository" });
  for (const o of out.outputs) if (o.startsWith("/") || /(^|\/)\.\.(\/|$)/.test(o)) out.diags.push({ line: 0, severity: "error", message: `build output path \`${o}\` must be inside the project` });
  return out;
}

export function compileParsed(parsed: ParsedRecipe, source: string, path: string, rawFacts: ProjectFacts, project: ProjectSection, ctx: CompileContext | null): CompiledRecipe {
  const diags: Diagnostic[] = [...parsed.problems.map((p) => ({ line: p.line, severity: "error" as const, message: p.message })), ...project.diags];
  const used = new Map<string, string>();
  const use = (c: Capability) => used.set(c.id, c.version);
  for (const id of project.used) use(capability(id));

  // Facts, with the person's statements taking precedence over detection.
  const facts: ProjectFacts = JSON.parse(JSON.stringify(rawFacts));
  if (project.tool && facts.node) {
    if (project.tool === "bun") { facts.node.packageManager = "bun"; }
    else facts.node.packageManager = project.tool as any;
    const lock = { npm: "package-lock.json", pnpm: "pnpm-lock.yaml", yarn: "yarn.lock", bun: facts.node.lockfile?.includes("bun.lockb") ? "bun.lockb" : "bun.lock" }[project.tool]!;
    facts.node.lockfile = facts.evidence.some((e) => e.endsWith(lock)) ? lock : null;
  }
  let eco: Ecosystem | null = project.ecosystem;
  if (eco && !facts.ecosystems.includes(eco) && !(eco === "node" && facts.ecosystems.includes("bun"))) {
    diags.push({ line: 0, severity: "error", message: `the recipe says this is a ${eco} project, but ${project.dir === "." ? "the repository root" : `\`${project.dir}\``} has no ${eco} project files (found: ${facts.ecosystems.join(", ") || "none"})` });
  }
  if (!eco) {
    if (facts.ecosystems.length === 1) eco = facts.ecosystems[0];
    else if (facts.ecosystems.length === 0) diags.push({ line: 0, severity: "decision", message: `Boundry couldn't tell what kind of project ${project.dir === "." ? "this is" : `\`${project.dir}\` is`} (no package.json, Cargo.toml, go.mod, pyproject.toml or requirements.txt). If it lives in a folder, say so under About this project: “The application is in \`folder\`”.` });
    else diags.push({ line: 0, severity: "decision", message: `this repository contains more than one kind of project (${facts.ecosystems.join(", ")}). Say which one this recipe is for under About this project, e.g. “This is a ${facts.ecosystems[0]} project”.` });
  }
  if (eco === "node" && facts.ecosystems.includes("bun")) eco = "bun";

  // ── When ──
  const triggers: Trigger[] = [];
  const whenLines = parsed.sections.when ?? [];
  if (!whenLines.length) diags.push({ line: parsed.titleLine, severity: "error", message: "say when this should happen under “## When this happens”" });
  for (const l of whenLines) {
    const n = normalize(l.text);
    const parts = matchPhrase("trigger", n) ? [n] : n.split(/\s*,?\s+\bor\b\s+|\s*,\s*/).filter(Boolean);
    for (const part of parts) {
      const m = matchPhrase("trigger", part);
      if (!m) { diags.push({ line: l.line, severity: "error", message: `I don't know when “${part}” happens`, suggestions: suggest("trigger", part) }); continue; }
      use(m.cap);
      const t = triggerOf(m.cap.id, m.slots, part);
      if ("error" in t) diags.push({ line: l.line, severity: "error", message: t.error });
      else triggers.push(t);
    }
  }

  // ── Make sure / Steps resolution ──
  const tc = eco && !diags.some((d) => d.severity === "decision") ? toolchainFor(facts, eco) : null;
  if (tc && isUnsupported(tc)) diags.push({ line: 0, severity: tc.status === "unavailable" ? "unsupported" : "decision", message: tc.unsupported });
  const toolchain = tc && !isUnsupported(tc) ? tc : null;

  interface Item { line: Line; cap: Capability; custom?: { script: string; needsInternet: boolean; name: string }; approval: string[] }
  const checks: Item[] = [];
  const seenChecks = new Set<string>();
  for (const l of parsed.sections.makeSure ?? []) {
    const n = normalize(l.text);
    if (VAGUE[n]) { diags.push({ line: l.line, severity: "error", message: `${VAGUE[n]}.`, suggestions: VAGUE_SUGGESTIONS }); continue; }
    const m = matchPhrase("check", n);
    if (!m) { diags.push({ line: l.line, severity: "error", message: `I don't know how to check “${l.text.replace(/\.$/, "")}”`, suggestions: suggest("check", n) }); continue; }
    if (seenChecks.has(m.cap.id)) { diags.push({ line: l.line, severity: "error", message: `“${l.text}” repeats an earlier check` }); continue; }
    seenChecks.add(m.cap.id); use(m.cap);
    checks.push({ line: l, cap: m.cap, approval: [] });
  }
  for (const c of parsed.custom) {
    checks.push({ line: { text: c.name, line: c.line }, cap: CUSTOM, custom: { script: c.script, needsInternet: c.needsInternet, name: c.name }, approval: [] });
  }

  const steps: Item[] = [];
  let pendingApproval: { people: string[]; line: number } | null = null;
  for (const l of parsed.sections.steps ?? []) {
    const n = normalize(l.text);
    const m = matchPhrase(["step", "approval"], n);
    if (!m) {
      const hint = /^publish/.test(n) ? ["Publish the package to npm"] : suggest(["step", "approval"], n);
      diags.push({ line: l.line, severity: /^publish package$|^publish it$/.test(n) ? "decision" : "error", message: /^publish package$|^publish it$/.test(n) ? "where should the package be published? Boundry can publish to npm (say “Publish the package to npm”)" : `I don't know how to “${l.text.replace(/\.$/, "")}”`, suggestions: hint });
      continue;
    }
    use(m.cap);
    if (m.cap.kind === "approval") { pendingApproval = { people: [...(pendingApproval?.people ?? []), m.slots[0]].sort(), line: l.line }; continue; }
    steps.push({ line: l, cap: m.cap, approval: pendingApproval?.people ?? [] });
    pendingApproval = null;
  }
  if (pendingApproval) diags.push({ line: pendingApproval.line, severity: "error", message: "an approval must be followed by the step it approves" });
  if (!checks.length && !steps.length) diags.push({ line: parsed.titleLine, severity: "error", message: "the recipe doesn't ask Boundry to do anything: add items under “## Make sure” or “## Steps”" });

  // ── Keep / Afterward ──
  const keeps = new Map<string, { line: number; days: number | null; always: boolean; producedBy: string[] }>();
  let evidence = true;
  for (const l of parsed.sections.keep ?? []) {
    let n = normalize(l.text);
    let days: number | null = null;
    const d = /\s+for\s+(\d{1,4})\s+days?$/.exec(n);
    if (d) { days = Number(d[1]); n = n.slice(0, d.index); }
    const m = matchPhrase("keep", n);
    if (!m) { diags.push({ line: l.line, severity: "error", message: `I don't know what “${l.text}” refers to`, suggestions: suggest("keep", n) }); continue; }
    use(m.cap);
    if (m.cap.id === "keep.evidence") { evidence = true; continue; }
    keeps.set(m.cap.keeps!.artifact, { line: l.line, days, always: !!m.cap.keeps!.always, producedBy: m.cap.keeps!.producedBy });
  }
  let report = false;
  for (const l of parsed.sections.afterward ?? []) {
    const n = normalize(l.text);
    const m = matchPhrase("after", n);
    if (!m) { diags.push({ line: l.line, severity: "error", message: `I don't know how to “${l.text}”`, suggestions: suggest("after", n) }); continue; }
    use(m.cap);
    if (m.cap.status === "unavailable") { diags.push({ line: l.line, severity: "unsupported", message: `“${l.text}” is not available yet: ${m.cap.note}` }); continue; }
    if (m.cap.id === "after.report") report = true;
  }

  // ── Build jobs ──
  const jobs: PlanJob[] = [];
  const explained: ExplainedJob[] = [];
  const producers = new Map<string, string>(); // artifact → job key
  const checkKeys: string[] = [];
  const slugOf = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "item";

  const resolve = (it: Item) => {
    if (!eco || !toolchain) return null;
    if (it.custom) return { run: [it.custom.script], summary: "runs the custom script exactly as written (not checked by Boundry)", status: "implemented" as Status };
    if (it.cap.status === "unavailable" || !it.cap.implement) {
      diags.push({ line: it.line.line, severity: "unsupported", message: `“${it.line.text.replace(/\.$/, "")}” is not available yet${it.cap.note ? `: ${it.cap.note}` : ""}` });
      return null;
    }
    const r = it.cap.implement(facts, eco, toolchain);
    if (isUnsupported(r)) { diags.push({ line: it.line.line, severity: "unsupported", message: `“${it.line.text.replace(/\.$/, "")}”: ${r.unsupported}` }); return null; }
    return { ...r, status: (r.status ?? (toolchain.tc.status === "implemented" ? it.cap.status : toolchain.tc.status)) as Status };
  };

  const makeJob = (it: Item, key: string, needs: string[]): void => {
    const r = resolve(it);
    if (!r || !toolchain) return;
    const tcx = toolchain.tc;
    const isPublish = !!it.cap.permissions?.length;
    const install = !it.cap.input && toolchain.install.length > 0;
    const runSteps: { name: string; run: string }[] = [];
    if (install) runSteps.push({ name: "Install dependencies", run: toolchain.install.join("\n") });
    let main = r.run.join("\n");
    const out = it.cap.output && keeps.has(it.cap.output) ? it.cap.output : (it.cap.id === "step.package" || it.cap.id === "step.verify-package" ? it.cap.output : undefined);
    const artifacts: PlanJob["artifacts"] = [];
    const keptHere: string[] = [];
    if (out === "test-results.txt") {
      main = `mkdir -p boundry-out\nrc=0\n{\n${main}\n} > boundry-out/test-results.txt 2>&1 || rc=$?\ncat boundry-out/test-results.txt\n[ "$rc" -eq 0 ] || exit "$rc"`;
    }
    runSteps.push({ name: it.custom ? it.custom.name : it.line.text.replace(/\.$/, ""), run: main });
    if (out === "build-output.tar") {
      const paths = eco === "rust" ? null : project.outputs;
      if (eco === "rust") runSteps.push({ name: "Keep the build output", run: `mkdir -p boundry-out/build\nfind target/release -maxdepth 1 -type f -perm -u+x -exec cp {} boundry-out/build/ \\;\n${TAR} -cf boundry-out/build-output.tar -C boundry-out/build .` });
      else if (!paths?.length) {
        const k = keeps.get(out)!;
        const guess = facts.node?.hints.main ? facts.node.hints.main.split("/")[0] : null;
        diags.push({ line: k.line, severity: "decision", message: `where does the build put its output? Say it under About this project, e.g. “The build output is in \`${guess && guess !== facts.node?.hints.main ? guess : "dist"}\`”` });
      } else runSteps.push({ name: "Keep the build output", run: `mkdir -p boundry-out\n${TAR} -cf boundry-out/build-output.tar ${paths.map((p) => `'${p.replace(/'/g, "")}'`).join(" ")}` });
    }
    if (out === "package.tar") runSteps.push({ name: "Seal the package", run: `${TAR} -cf boundry-out/package.tar -C boundry-out/pkg .` });
    if (out) {
      const k = keeps.get(out);
      artifacts.push({ name: out, path: `boundry-out/${out}`, retentionDays: k?.days ?? DEFAULT_RETENTION[out], ...(k?.always ? { always: true } : {}) } as any);
      producers.set(out, key);
      keptHere.push(out);
    }
    const inputs = it.cap.input ? [{ job: producers.get(it.cap.input)!, artifact: it.cap.input }] : [];
    if (it.cap.input && !producers.has(it.cap.input)) {
      diags.push({ line: it.line.line, severity: "error", message: `“${it.line.text.replace(/\.$/, "")}” needs a package: add “Package the result” as an earlier step` });
      return;
    }
    const net = install || !!it.custom?.needsInternet || isPublish || it.cap.id === "check.dependencies";
    const job: PlanJob = {
      key, job: key, name: it.custom ? it.custom.name : it.line.text.replace(/\.$/, ""), matrix: {},
      image: tcx.image, requires: [...tcx.requires, ...(it.cap.permissions ?? [])].sort(), needs: [...needs].sort(),
      network: net ? "egress" : "none", resources: { ...tcx.resources }, timeoutMinutes: tcx.timeoutMinutes,
      retry: isPublish ? { maxAttempts: 1, on: [] } : { maxAttempts: 2, on: ["infrastructure"] },
      env: Object.fromEntries(Object.entries(tcx.env).sort()), secrets: [...(it.cap.secrets ?? [])].sort(),
      permissions: { release: !!it.cap.permissions?.includes("release"), deploy: !!it.cap.permissions?.includes("deploy") },
      approval: { required: it.approval.length > 0, approvers: it.approval },
      cache: isPublish ? [] : tcx.cache.map((c) => ({ ...c, keyFiles: [...c.keyFiles].sort() })),
      artifacts, steps: runSteps,
      ...(tcx.imageDigest ? { imageDigest: tcx.imageDigest } : {}),
      ...(inputs.length ? { inputs } : {}),
      capabilities: [`${it.cap.id}@${it.cap.version}`, `toolchain.${tcx.id}`],
      ...(it.custom ? { custom: true } : {}),
    } as PlanJob;
    jobs.push(job);
    explained.push({
      key, order: 0, words: job.name, capability: it.cap.id, capabilityVersion: it.cap.version, status: r.status, custom: !!it.custom,
      toolchain: tcx.label, summary: r.summary, install, network: net, keeps: keptHere, inputs: inputs.map((i) => i.artifact),
      approval: it.approval, permissions: it.cap.permissions ?? [], secrets: it.cap.secrets ?? [], after: needs,
    });
  };

  const taken = new Set<string>();
  const stepOrder = new Map<string, number>();
  for (const it of checks) {
    let key = it.custom ? `custom-${slugOf(it.custom.name)}` : it.cap.id.replace(/^check\./, "");
    while (taken.has(key)) key += "-2";
    taken.add(key);
    makeJob(it, key, []);
    if (jobs.some((j) => j.key === key)) checkKeys.push(key);
  }
  let prev: string[] = checkKeys;
  steps.forEach((it, i) => {
    // Keys are stable under insertion/removal of other steps (reviewable diffs); order lives in `needs`.
    let key = `step-${it.cap.id.replace(/^step\./, "")}`;
    while (taken.has(key)) key += "-2";
    taken.add(key);
    stepOrder.set(key, i + 1);
    const isConsequential = !!it.cap.permissions?.length;
    if (isConsequential && !it.approval.length) diags.push({ line: it.line.line, severity: "error", message: `“${it.line.text.replace(/\.$/, "")}” has real consequences, so it needs an approval first: add a step before it like “Ask <name> to approve the release”` });
    if (isConsequential && triggers.some((t) => t.kind === "pull_request")) diags.push({ line: it.line.line, severity: "error", message: `“${it.line.text.replace(/\.$/, "")}” can't run when a change is proposed; start this recipe from a version tag or by hand` });
    makeJob(it, key, prev);
    if (jobs.some((j) => j.key === key)) prev = [key];
  });

  for (const [artifact, k] of keeps) {
    if (!producers.has(artifact)) {
      const by = k.producedBy.map((id) => sayOf(capability(id))).join("” or “");
      if (!diags.some((d) => d.line === k.line)) diags.push({ line: k.line, severity: "error", message: `nothing in this recipe produces that: also add “${by}”` });
    }
  }

  // Every diagnostic blocks: an unsupported item is never silently dropped from a recipe.
  if (diags.length) throw new RecipeError(path, diags.sort((a, b) => a.line - b.line));

  for (const e of explained) e.order = stepOrder.get(e.key) ?? 0;
  jobs.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  explained.sort((a, b) => (a.key < b.key ? -1 : 1));
  const sourceDigest = sha256Hex(source);
  const capabilities = Object.fromEntries([...used.entries()].sort());
  const slug = slugOf(path.split("/").pop()!.replace(/\.md$/, ""));
  // What will execute (not the recipe bytes, which are provenance and recorded separately as sourceDigest).
  const definition = { compiler: COMPILER_VERSION, catalog: CATALOG_VERSION, capabilities, factsDigest: factsDigest(rawFacts), triggers: triggers.map(({ words: _w, ...t }) => t), report, jobs };
  const definitionDigest = sha256Hex(canonicalJson(definition));
  const context: CompileContext = ctx ?? { repository: "(any)", kind: triggers[0]?.kind ?? "manual", ref: "(any)", sha: "0".repeat(40), trusted: true };
  const accepted = ctx ? accepts(triggers, ctx) : true;
  const isRelease = jobs.some((j) => j.permissions.release || j.permissions.deploy);
  const plan: Plan = {
    compiler: COMPILER_VERSION, pipeline: parsed.title, sourceDigest, context,
    concurrency: accepted && !isRelease && ctx && (ctx.kind === "pull_request" || ctx.kind === "push") ? { group: `${ctx.repository}/${ctx.ref}/${slug}`, cancelInProgress: true } : null,
    downstream: [], jobs: accepted ? jobs : [],
    report, recipe: { path, slug, definitionDigest, catalog: CATALOG_VERSION, capabilities, factsDigest: factsDigest(rawFacts) },
  } as Plan;
  return {
    path, title: parsed.title, purpose: parsed.purpose, sourceDigest, compiler: COMPILER_VERSION, catalog: CATALOG_VERSION, capabilities,
    facts: rawFacts, factsDigest: factsDigest(rawFacts), ecosystem: eco!, triggers, report, evidence, retentionDays: Object.fromEntries([...keeps].map(([a, k]) => [a, k.days ?? DEFAULT_RETENTION[a]])),
    jobs: explained, definitionDigest, plan, planDigest: sha256Hex(canonicalJson(plan)),
  };
}

const CUSTOM: Capability = { id: "custom.check", version: "1.0.0", kind: "check", status: "implemented", title: "Custom check (escape hatch)", phrases: [], evidence: ["exit status", "log"] };

const WEEKDAY: Record<string, number> = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };
function triggerOf(id: string, slots: string[], words: string): Trigger | { error: string } {
  switch (id) {
    case "trigger.change-proposed": return { capability: id, kind: "pull_request", words };
    case "trigger.branch-updated": return { capability: id, kind: "push", branches: [slots[0]], words };
    case "trigger.version-tagged": return { capability: id, kind: "tag", words };
    case "trigger.manual": return { capability: id, kind: "manual", words };
    case "trigger.schedule": {
      if (words === "every night") return { capability: id, kind: "schedule", cron: "17 3 * * *", scheduleBranch: "main", words };
      const time = slots.length === 2 ? slots[1] : slots[0];
      const [h, m] = time.split(":").map(Number);
      if (h > 23) return { error: `${time} is not a time of day` };
      const dow = slots.length === 2 ? String(WEEKDAY[slots[0]]) : "*";
      return { capability: id, kind: "schedule", cron: `${m} ${h} * * ${dow}`, scheduleBranch: "main", words };
    }
  }
  return { error: `unknown trigger ${id}` };
}

export function accepts(triggers: Trigger[], ctx: CompileContext): boolean {
  const branch = ctx.ref.startsWith("refs/heads/") ? ctx.ref.slice(11) : null;
  return triggers.some((t) => {
    switch (t.kind) {
      case "pull_request": return ctx.kind === "pull_request";
      case "push": return ctx.kind === "push" && branch !== null && t.branches!.some((b) => globMatch(b, branch));
      case "tag": return ctx.kind === "tag" && globMatch("v*", ctx.ref.replace(/^refs\/tags\//, ""));
      case "manual": return ctx.kind === "manual";
      case "schedule": return ctx.kind === "schedule" && ctx.cron === t.cron;
    }
  });
}

/** Every capability, with its status, for documentation and `recipe capabilities`. */
export function catalogTable(): { id: string; version: string; kind: string; status: Status; says: string; note?: string }[] {
  return CAPABILITIES.map((c) => ({ id: c.id, version: c.version, kind: c.kind, status: c.status, says: display(c.phrases[0]), ...(c.note ? { note: c.note } : {}) }));
}
export type { Toolchain };
