// Legacy conversion: GitHub Actions workflows and .boundry/ci.yaml → a DRAFT recipe plus an honest report.
// It recognises common patterns only. Everything else is listed as needing a human decision or unsupported;
// nothing is silently dropped and nothing is guessed into a consequential action.
import YAML from "yaml";
import { SAY } from "./catalog.ts";

export interface ConversionReport {
  source: string; kind: "github-actions" | "boundry-ci-yaml";
  translated: string[]; decisions: string[]; unsupported: string[]; behaviorChanges: string[];
  recipe: string;
}

type Outcome = { check?: string; step?: string; keep?: string; note?: string; implicit?: string };

// Command patterns → catalog capabilities. Order matters (first match wins).
const COMMANDS: [RegExp, Outcome][] = [
  [/^(npm ci|npm install|pnpm install|yarn install|bun install|corepack enable)\b/, { implicit: "dependency installation (Boundry installs from the lockfile)" }],
  [/^(npm|pnpm|yarn|bun) (run )?build\b|^tsc -b\b|^tsc\b(?!.*--noEmit)/, { check: "check.builds" }],
  [/^(npm|pnpm|yarn) (run )?typecheck\b|^tsc --noEmit\b|^(npm|pnpm|yarn) run type-check\b/, { check: "check.types" }],
  [/^(npm|pnpm|yarn|bun) (run )?test\b(?!:)|^npm t\b|^(npx )?vitest run\b|^bun test\b/, { check: "check.tests" }],
  [/^(npm|pnpm|yarn) (run )?lint\b/, { check: "check.lint" }],
  [/^npm audit\b/, { check: "check.dependencies" }],
  [/^cargo (build|check)\b/, { check: "check.builds" }],
  [/^cargo test\b/, { check: "check.tests" }],
  [/^cargo fmt\b.*--check/, { check: "check.formatted" }],
  [/^cargo clippy\b/, { check: "check.lint" }],
  [/^go build\b/, { check: "check.builds" }],
  [/^go test\b/, { check: "check.tests" }],
  [/^go vet\b/, { check: "check.lint" }],
  [/^(python -m )?pytest\b/, { check: "check.tests" }],
  [/playwright|test:browser|test:e2e/, { note: "unsupported:browser tests (no browser toolchain matched to the project's Playwright version yet)" }],
  [/^npm publish\b|publish:packages\b|^cargo publish\b|^gh release\b/, { note: "decision:publishing — add “Package the result”, an approval, and a publish step deliberately" }],
  [/^npm pack\b|^cargo package\b/, { step: "step.package" }],
];

const ACTIONS: [RegExp, string][] = [
  [/^actions\/checkout$/, "implicit:checkout (Boundry checks out the exact commit; .git is not available to jobs)"],
  [/^actions\/setup-node$/, "implicit:toolchain (Boundry pins Node.js 22)"],
  [/^(dtolnay\/rust-toolchain|actions-rs\/toolchain)$/, "implicit:toolchain (Boundry pins its Rust toolchain image with rustfmt and clippy)"],
  [/^actions\/setup-go$/, "implicit:toolchain (Boundry pins Go 1.23)"],
  [/^actions\/setup-python$/, "implicit:toolchain (Boundry pins Python 3.12)"],
  [/^(actions\/cache|Swatinem\/rust-cache)$/, "implicit:caching (Boundry keeps trust-scoped caches keyed by the lockfile)"],
  [/^actions\/upload-artifact$/, "keep"],
  [/^actions\/download-artifact$/, "unsupported:downloading artifacts from other workflows"],
];

export function convertGithubWorkflow(source: string, name: string): ConversionReport {
  const doc: any = YAML.parse(source, { version: "1.1" }) ?? {};
  const on = doc.on ?? doc[true as any] ?? {};
  const r: ConversionReport = { source: name, kind: "github-actions", translated: [], decisions: [], unsupported: [], behaviorChanges: [], recipe: "" };
  const when: string[] = [];
  const triggers = typeof on === "string" ? { [on]: {} } : Array.isArray(on) ? Object.fromEntries(on.map((k: string) => [k, {}])) : on;
  for (const [ev, cfg] of Object.entries<any>(triggers)) {
    if (ev === "pull_request") { when.push("Someone proposes a change."); r.translated.push("on: pull_request → “Someone proposes a change”"); if (cfg?.branches || cfg?.paths) r.behaviorChanges.push(`pull_request filters (${Object.keys(cfg).join(", ")}) are not carried over: every proposed change runs`); }
    else if (ev === "push") {
      const branches: string[] = cfg?.branches ?? [];
      const tags: string[] = cfg?.tags ?? [];
      for (const b of branches) { if (/[*?]/.test(b)) r.decisions.push(`push to branch pattern \`${b}\`: recipes name branches exactly; say which branch`); else { when.push(`The ${b} branch is updated.`); r.translated.push(`on: push ${b} → “The ${b} branch is updated”`); } }
      if (tags.length) { when.push("A version is tagged."); r.translated.push("on: push tags → “A version is tagged”"); if (tags.some((t) => !/^v\*/.test(t))) r.behaviorChanges.push(`tag patterns ${tags.join(", ")} become “v*”`); }
      if (!branches.length && !tags.length) r.decisions.push("on: push (any branch): recipes run for named branches; say which");
      if (cfg?.paths || cfg?.["paths-ignore"]) r.behaviorChanges.push("push path filters are not carried over");
    }
    else if (ev === "workflow_dispatch") { when.push("I start it."); r.translated.push("on: workflow_dispatch → “I start it”"); if (cfg?.inputs) r.unsupported.push(`manual inputs (${Object.keys(cfg.inputs).join(", ")})`); }
    else if (ev === "schedule") {
      for (const s of cfg as any[]) {
        const m = /^(\d+) (\d+) \* \* \*$/.exec(s.cron);
        if (m) { when.push(`Every day at ${m[2].padStart(2, "0")}:${m[1].padStart(2, "0")} UTC.`); r.translated.push(`schedule ${s.cron} → daily`); }
        else r.decisions.push(`schedule \`${s.cron}\`: only daily/weekly times are expressible; choose one`);
      }
    }
    else if (ev === "workflow_call") r.unsupported.push("reusable workflow (workflow_call): convert the calling workflows instead");
    else r.unsupported.push(`trigger \`${ev}\``);
  }

  const checks = new Set<string>(), steps: string[] = [], keeps = new Set<string>(), custom: { name: string; script: string }[] = [];
  for (const [jobId, job] of Object.entries<any>(doc.jobs ?? {})) {
    const runsOn = JSON.stringify(job["runs-on"] ?? "");
    if (/macos|windows/i.test(runsOn)) r.unsupported.push(`job \`${jobId}\` runs on ${runsOn}: no macOS/Windows worker (kept on GitHub Actions for now)`);
    if (job.strategy?.matrix) r.behaviorChanges.push(`job \`${jobId}\` matrix (${Object.keys(job.strategy.matrix).join(", ")}) collapses to Boundry's single pinned toolchain`);
    if (job.services) r.unsupported.push(`job \`${jobId}\` service containers (${Object.keys(job.services).join(", ")})`);
    if (job.environment) r.decisions.push(`job \`${jobId}\` uses environment \`${typeof job.environment === "string" ? job.environment : job.environment.name}\`: express protection as an approval step`);
    if (job.uses) { r.unsupported.push(`job \`${jobId}\` calls reusable workflow ${job.uses}`); continue; }
    for (const step of job.steps ?? []) {
      if (step.uses) {
        const action = String(step.uses).split("@")[0];
        const a = ACTIONS.find(([re]) => re.test(action));
        if (!a) { r.unsupported.push(`action \`${action}\` (job \`${jobId}\`)`); continue; }
        if (a[1] === "keep") {
          const path = String(step.with?.path ?? "");
          const name = String(step.with?.name ?? "");
          if (/test|junit|report|result/i.test(name + path)) { keeps.add("keep.test-results"); r.translated.push(`upload-artifact ${name || path} → “The test results”`); }
          else r.decisions.push(`upload-artifact \`${name || path}\`: is this the build output? If so, keep “The build output” and say where it is`);
          continue;
        }
        const [k, msg] = a[1].split(/:(.*)/s);
        if (k === "implicit") r.translated.push(`${action} → ${msg}`);
        else r.unsupported.push(msg);
        if (action === "actions/setup-node" && step.with?.["node-version"] && !/^22/.test(String(step.with["node-version"]))) r.behaviorChanges.push(`Node.js ${step.with["node-version"]} → 22 (Boundry's pinned Node toolchain)`);
        continue;
      }
      if (typeof step.run !== "string") continue;
      if (/\$\{\{/.test(step.run) && /secrets\./.test(step.run)) r.decisions.push(`step “${step.name ?? step.run.split("\n")[0]}” uses secrets: recipes grant secrets only to approved publish steps`);
      for (const raw of step.run.split("\n").map((l: string) => l.trim()).filter((l: string) => l && !l.startsWith("#"))) {
        const line = raw.replace(/^\s*(sudo )?/, "");
        const hit = COMMANDS.find(([re]) => re.test(line));
        if (!hit) {
          custom.push({ name: step.name ?? `${jobId}: ${line.slice(0, 40)}`, script: line });
          r.decisions.push(`\`${line.slice(0, 80)}\` has no catalog equivalent: drafted as a custom check — keep it, replace it, or remove it`);
          continue;
        }
        const o = hit[1];
        if (o.implicit) r.translated.push(`\`${line}\` → ${o.implicit}`);
        if (o.check) { if (!checks.has(o.check)) r.translated.push(`\`${line}\` → “${SAY[o.check]}”`); checks.add(o.check); }
        if (o.step) { steps.push(o.step); r.translated.push(`\`${line}\` → “${SAY[o.step]}”`); }
        if (o.note) { const [k, msg] = o.note.split(/:(.*)/s); (k === "unsupported" ? r.unsupported : r.decisions).push(`${msg} (\`${line.slice(0, 60)}\`)`); }
      }
    }
  }
  r.recipe = render(doc.name ?? name, when, checks, steps, keeps, custom, r);
  return r;
}

/** Legacy .boundry/ci.yaml: same command mapping over each job's steps. */
export function convertLegacyCiYaml(source: string, name: string): ConversionReport {
  const doc: any = YAML.parse(source) ?? {};
  const gha = { name: doc.name ?? name, on: Object.fromEntries(Object.entries<any>(doc.on ?? {}).map(([k, v]) => [k === "manual" ? "workflow_dispatch" : k === "tag" ? "push" : k, k === "tag" ? { tags: v?.patterns ?? ["v*"] } : v])), jobs: Object.fromEntries(Object.entries<any>(doc.jobs ?? {}).map(([k, j]) => [k, { steps: (j.steps ?? []).map((s: any) => ({ name: s.name, run: s.run })) }])) };
  const r = convertGithubWorkflow(YAML.stringify(gha), name);
  r.kind = "boundry-ci-yaml";
  const anyJob = Object.values<any>(doc.jobs ?? {});
  if (anyJob.some((j) => j.network === "egress")) r.translated.push("network: egress → implicit (Boundry gives dependency-installing jobs internet access)");
  if (anyJob.some((j) => j.cache)) r.translated.push("cache → implicit (trust-scoped, keyed by the lockfile)");
  if (anyJob.some((j) => j.image)) r.behaviorChanges.push("explicit images are replaced by Boundry's pinned toolchain for the detected project");
  if (anyJob.some((j) => j.artifacts)) r.decisions.push(`artifacts ${anyJob.flatMap((j) => (j.artifacts ?? []).map((a: any) => `\`${a.path}\``)).join(", ")}: keep “The build output” or “The package” and say where it is`);
  return r;
}

function render(title: string, when: string[], checks: Set<string>, steps: string[], keeps: Set<string>, custom: { name: string; script: string }[], r: ConversionReport): string {
  const L = [`# ${title}`, "", `Converted from \`${r.source}\`. Review every item in the conversion report before relying on it.`, "", "## When this happens"];
  L.push(...(when.length ? [...new Set(when)].map((w) => `- ${w}`) : ["- I start it."]));
  if (!when.length) r.decisions.push("no convertible trigger: the draft runs only when started by hand");
  const order = ["check.builds", "check.tests", "check.types", "check.lint", "check.formatted", "check.dependencies"];
  if (checks.size) L.push("", "## Make sure", ...order.filter((c) => checks.has(c)).map((c) => `- ${SAY[c]}.`));
  if (steps.length) L.push("", "## Steps", ...[...new Set(steps)].map((s, i) => `${i + 1}. ${SAY[s]}.`));
  L.push("", "## Keep");
  if (checks.has("check.tests")) keeps.add("keep.test-results");
  for (const k of keeps) L.push(`- ${SAY[k]}.`);
  L.push("- A record of what was checked.", "", "## Afterward", "- Report the result on the change.");
  if (custom.length) {
    L.push("", "## Custom checks");
    for (const c of custom) L.push("", `### ${c.name}`, "Needs the internet.", "```sh", c.script, "```");
  }
  return L.join("\n") + "\n";
}

export function renderReport(r: ConversionReport, compileResult: string): string {
  const sec = (t: string, xs: string[]) => [`### ${t} (${xs.length})`, ...(xs.length ? [...new Set(xs)].map((x) => `- ${x}`) : ["- none"]), ""];
  return [`## \`${r.source}\` (${r.kind})`, "", ...sec("Translated", r.translated), ...sec("Needs a human decision", r.decisions), ...sec("Unsupported", r.unsupported), ...sec("Behaviour changes", r.behaviorChanges),
    "### Draft recipe", "", "```markdown", r.recipe.trimEnd(), "```", "", "### Does the draft compile against the repository?", "", compileResult, ""].join("\n");
}
