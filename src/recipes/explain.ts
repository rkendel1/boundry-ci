// Human-readable explanation of a compiled recipe, and a reviewable diff between two compilations.
import type { CompiledRecipe, Diagnostic, ExplainedJob } from "./compile.ts";
import { display } from "./catalog.ts";

const TRIGGER_WORDS: Record<string, (t: any) => string> = {
  pull_request: () => "someone opens or updates a pull request",
  push: (t) => `new commits reach ${t.branches.map((b: string) => `\`${b}\``).join(" or ")}`,
  tag: () => "a version tag (v…) is pushed",
  manual: () => "an authorized person starts it",
  schedule: (t) => `on schedule \`${t.cron}\` (UTC) against \`${t.scheduleBranch}\``,
};

export function explain(c: CompiledRecipe): string {
  const L: string[] = [];
  L.push(`# ${c.title}`, "");
  if (c.purpose) L.push(c.purpose, "");
  L.push(`Recipe \`${c.path}\` · sha256:${c.sourceDigest.slice(0, 12)} · compiled by ${c.compiler} with ${c.catalog} · definition ${c.definitionDigest.slice(0, 12)}`, "");
  L.push("## Runs when", ...c.triggers.map((t) => `- ${TRIGGER_WORDS[t.kind](t)}`), "");
  const eco = c.ecosystem;
  const where = c.facts.dir === "." ? "the repository root" : `\`${c.facts.dir}\``;
  L.push("## Project", `- ${label(eco, c)} in ${where} (evidence: ${c.facts.evidence.map((e) => `\`${e}\``).join(", ")})`, "");
  const checks = c.jobs.filter((j) => !j.key.startsWith("step-"));
  const steps = c.jobs.filter((j) => j.key.startsWith("step-")).sort((a, b) => a.order - b.order);
  if (checks.length) {
    L.push(`## Checks (${checks.length === 1 ? "one job" : `${checks.length} jobs at the same time`})`);
    checks.forEach((j, i) => L.push(...jobLines(`${i + 1}.`, j)));
    L.push("");
  }
  if (steps.length) {
    L.push(`## Steps (in order${checks.length ? ", after every check passes" : ""})`);
    steps.forEach((j, i) => L.push(...jobLines(`${i + 1}.`, j)));
    L.push("");
  }
  const perms = [...new Set(c.jobs.flatMap((j) => j.permissions))];
  const secrets = [...new Set(c.jobs.flatMap((j) => j.secrets))];
  const approvals = c.jobs.filter((j) => j.approval.length);
  L.push("## Authority");
  L.push(`- Permissions: ${perms.length ? perms.map((p) => `**${p}**`).join(", ") : "none"}`);
  L.push(`- Secrets: ${secrets.length ? secrets.map((s) => `\`${s}\``).join(", ") : "none"}`);
  L.push(`- Approvals: ${approvals.length ? approvals.map((j) => `${j.approval.join(" or ")} before “${j.words}”`).join("; ") : "none"}`);
  L.push(`- Publishes or deploys: ${c.jobs.some((j) => j.permissions.length) ? c.jobs.filter((j) => j.permissions.length).map((j) => `“${j.words}”`).join(", ") : "nothing"}`);
  L.push(`- Proposed changes from forks never receive secrets, release/deploy access or trusted caches.`, "");
  L.push("## Kept");
  const kept = c.jobs.flatMap((j) => j.keeps.map((k) => `- \`${k}\` from “${j.words}” for ${c.retentionDays[k] ?? "default"} days${k === "test-results.txt" ? " (also when tests fail)" : ""}`));
  L.push(...kept, "- The record: this recipe, its compiled plan, project facts, every attempt's log, inputs and outputs (always)", "");
  L.push("## Afterward", c.report ? "- The result is reported on the commit/pull request as statuses" : "- Nothing is reported to GitHub (add “Report the result on the change” to do so)", "");
  const partial = c.jobs.filter((j) => j.status !== "implemented");
  if (partial.length) L.push("## Caution", ...partial.map((j) => `- “${j.words}” uses a capability marked **${j.status}**`), "");
  return L.join("\n");
}

function label(eco: string, c: CompiledRecipe): string {
  if (eco === "node") return `Node.js project using ${c.facts.node?.packageManager} (\`${c.facts.node?.lockfile}\`)`;
  if (eco === "rust") return `Rust project${c.facts.rust?.workspace ? " (workspace)" : c.facts.rust?.packageName ? ` (\`${c.facts.rust.packageName}\`)` : ""}`;
  return `${eco} project`;
}

function jobLines(n: string, j: ExplainedJob): string[] {
  const bits = [`${n} **${j.words}** — ${j.summary}${j.custom ? " ⚠ custom" : ""}`];
  const detail = [
    `${j.toolchain}`,
    j.install ? "installs dependencies first" : null,
    `internet: ${j.network ? "yes" : "no"}`,
    j.inputs.length ? `uses ${j.inputs.map((i) => `\`${i}\` (digest-verified)`).join(", ")}` : null,
    j.keeps.length ? `keeps ${j.keeps.map((k) => `\`${k}\``).join(", ")}` : null,
    j.approval.length ? `**waits for approval from ${j.approval.join(" or ")}**` : null,
    j.permissions.length ? `**needs ${j.permissions.join(", ")} permission**` : null,
    j.secrets.length ? `uses secret ${j.secrets.map((s) => `\`${s}\``).join(", ")}` : null,
    `capability \`${j.capability}@${j.capabilityVersion}\`${j.status !== "implemented" ? ` (${j.status})` : ""}`,
  ].filter(Boolean);
  bits.push(`   ${detail.join(" · ")}`);
  return bits;
}

export function explainDiagnostics(path: string, diags: Diagnostic[]): string {
  const L = [`${path}: Boundry can't run this recipe yet.`, ""];
  const tag = { error: "Fix", decision: "Decide", unsupported: "Not available" } as const;
  for (const d of diags) {
    L.push(`- ${d.line ? `line ${d.line}: ` : ""}[${tag[d.severity]}] ${d.message.charAt(0).toUpperCase() + d.message.slice(1)}`);
    if (d.suggestions?.length) L.push(`  Did you mean: ${d.suggestions.map((s) => `“${s}”`).join(", ")}?`);
  }
  return L.join("\n");
}

/** What changes if `next` replaces `prev`: the review a person signs off on. Consequential changes first. */
export function diffCompiled(prev: CompiledRecipe, next: CompiledRecipe): { changed: boolean; text: string } {
  const L: string[] = [];
  const byKey = (c: CompiledRecipe) => new Map(c.jobs.map((j) => [j.key, j]));
  const a = byKey(prev), b = byKey(next);
  const flag: string[] = [];
  const allA = new Set(prev.jobs.flatMap((j) => j.permissions)), allB = new Set(next.jobs.flatMap((j) => j.permissions));
  for (const p of allB) if (!allA.has(p)) flag.push(`NEW PERMISSION: ${p}`);
  for (const p of allA) if (!allB.has(p)) flag.push(`permission removed: ${p}`);
  const secA = new Set(prev.jobs.flatMap((j) => j.secrets)), secB = new Set(next.jobs.flatMap((j) => j.secrets));
  for (const s of secB) if (!secA.has(s)) flag.push(`NEW SECRET: ${s}`);
  const apA = prev.jobs.flatMap((j) => j.approval.map((p) => `${p}→${j.key}`)), apB = next.jobs.flatMap((j) => j.approval.map((p) => `${p}→${j.key}`));
  for (const x of apA) if (!apB.includes(x)) flag.push(`APPROVAL REMOVED: ${x}`);
  for (const x of apB) if (!apA.includes(x)) flag.push(`approval added: ${x}`);
  const tw = (c: CompiledRecipe) => c.triggers.map((t) => TRIGGER_WORDS[t.kind](t)).sort().join("; ");
  if (tw(prev) !== tw(next)) flag.push(`runs when: “${tw(prev)}” → “${tw(next)}”`);
  if (prev.report !== next.report) flag.push(`reporting to GitHub: ${prev.report ? "on" : "off"} → ${next.report ? "on" : "off"}`);
  if (flag.length) L.push("Needs attention:", ...flag.map((f) => `  ! ${f}`), "");
  for (const [k, j] of b) if (!a.has(k)) L.push(`+ ${k}: “${j.words}” — ${j.summary}`);
  for (const [k, j] of a) if (!b.has(k)) L.push(`- ${k}: “${j.words}”`);
  for (const [k, jb] of b) {
    const ja = a.get(k);
    if (!ja) continue;
    const fields = (["summary", "toolchain", "network", "keeps", "inputs", "after", "order", "approval", "capabilityVersion", "status"] as const).filter((f) => JSON.stringify(ja[f]) !== JSON.stringify(jb[f]));
    if (fields.length) L.push(`~ ${k}: ${fields.map((f) => `${f} ${JSON.stringify(ja[f])} → ${JSON.stringify(jb[f])}`).join("; ")}`);
  }
  if (prev.factsDigest !== next.factsDigest) L.push(`~ project facts changed (${prev.factsDigest.slice(0, 12)} → ${next.factsDigest.slice(0, 12)})`);
  if (prev.catalog !== next.catalog || prev.compiler !== next.compiler) L.push(`~ toolchain of Boundry itself: ${prev.compiler}/${prev.catalog} → ${next.compiler}/${next.catalog}`);
  const changed = prev.definitionDigest !== next.definitionDigest;
  L.unshift(changed ? `Plan changes (${prev.definitionDigest.slice(0, 12)} → ${next.definitionDigest.slice(0, 12)})` : `No change in what runs (${next.definitionDigest.slice(0, 12)})`, "");
  return { changed, text: L.join("\n") };
}

export { display };
