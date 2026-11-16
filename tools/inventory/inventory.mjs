#!/usr/bin/env node
// Deterministic GitHub Actions workflow inventory.
// Reads actual workflow YAML from local clones and emits one record per job.
// Usage: node tools/inventory/inventory.mjs <reposDir> [--json out.json] [--md out.md]
import { readdirSync, readFileSync, existsSync, statSync, writeFileSync } from "node:fs";
import { join, basename } from "node:path";
import YAML from "yaml";

const args = process.argv.slice(2);
const reposDir = args[0];
if (!reposDir) {
  console.error("usage: inventory.mjs <reposDir> [--json f] [--md f]");
  process.exit(2);
}
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };

const asList = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);

function triggers(on) {
  if (on == null) return [];
  if (typeof on === "string") return [on];
  if (Array.isArray(on)) return on;
  return Object.entries(on).map(([k, v]) => {
    if (k === "schedule") return `schedule(${asList(v).map((s) => s.cron).join(";")})`;
    if (v && typeof v === "object") {
      const bits = [];
      if (v.branches) bits.push(`branches=${asList(v.branches).join("|")}`);
      if (v.tags) bits.push(`tags=${asList(v.tags).join("|")}`);
      if (v.types) bits.push(`types=${asList(v.types).join("|")}`);
      if (v.paths) bits.push("paths");
      if (v.workflows) bits.push(`after=${asList(v.workflows).join("|")}`);
      return bits.length ? `${k}(${bits.join(",")})` : k;
    }
    return k;
  });
}

const SECRET_RE = /secrets\.([A-Za-z0-9_]+)/g;
const VARS_RE = /vars\.([A-Za-z0-9_]+)/g;

function collect(re, text) {
  const s = new Set();
  for (const m of text.matchAll(re)) s.add(m[1]);
  return [...s].sort();
}

// Rough capability classification from evidence in the job text.
function capabilities(runsOn, text) {
  const caps = new Set();
  const ro = JSON.stringify(runsOn ?? "").toLowerCase();
  if (/macos-(14|15|26|latest)(?!-intel)/.test(ro)) caps.add("macos-arm64");
  if (/macos-(13|15-intel)|macos[^"]*x64/.test(ro)) caps.add("macos-x64");
  if (ro.includes("windows")) caps.add("windows");
  if (/ubuntu[^"]*arm|linux-arm/.test(ro)) caps.add("linux-arm64");
  if (/playwright|chromium|puppeteer|browser-actions|setup-chrome/i.test(text)) caps.add("linux-browser");
  if (/cargo |rust-toolchain|dtolnay|zig build|setup-zig|docker build|buildx|wasm-pack/i.test(text)) caps.add("linux-build");
  if (/npm publish|pnpm publish|cargo publish|gh release|softprops\/action-gh-release|docker push|push: true|wrangler|r2|pages deploy/i.test(text)) caps.add("release");
  if (/flyctl|fly deploy|ssh |rsync|deploy/i.test(text)) caps.add("deploy");
  if (!caps.size || [...caps].every((c) => c === "release" || c === "deploy")) {
    if (!ro.includes("macos") && !ro.includes("windows")) caps.add("linux-small");
  }
  return [...caps].sort();
}

function toolchains(text) {
  const t = new Set();
  const m = (re, name) => { if (re.test(text)) t.add(name); };
  m(/setup-node|node-version/i, "node");
  m(/pnpm/i, "pnpm");
  m(/setup-bun|\bbun\b/i, "bun");
  m(/rust-toolchain|dtolnay|cargo /i, "rust");
  m(/setup-zig|zig build|\bzig\b/i, "zig");
  m(/setup-python|pip install|\bpython3? /i, "python");
  m(/setup-go|go build|go test/i, "go");
  m(/docker |buildx|docker\/build-push/i, "oci-build");
  m(/playwright/i, "playwright");
  m(/wasm32|wasm-pack|wasmtime/i, "wasm");
  m(/xcodebuild|xcrun|codesign|notarytool/i, "xcode");
  return [...t].sort();
}

function destinations(text) {
  const d = new Set();
  const m = (re, name) => { if (re.test(text)) d.add(name); };
  m(/npm publish|pnpm publish|NPM_TOKEN|registry\.npmjs/i, "npm");
  m(/cargo publish|CARGO_REGISTRY_TOKEN/i, "crates.io");
  m(/ghcr\.io/i, "ghcr");
  m(/docker\.io|DOCKERHUB/i, "dockerhub");
  m(/gh release|action-gh-release|create-release/i, "github-releases");
  m(/flyctl|fly deploy|FLY_API_TOKEN/i, "fly.io");
  m(/wrangler|cloudflare|R2_/i, "cloudflare");
  m(/actions\/deploy-pages|gh-pages|pages:/i, "github-pages");
  m(/testflight|altool|app-store/i, "app-store");
  m(/ssh |rsync|HETZNER|95\.217/i, "ssh-host");
  m(/homebrew|brew /i, "homebrew");
  m(/chrome web store|chrome-webstore|CWS_/i, "chrome-web-store");
  return [...d].sort();
}

const records = [];
const repos = readdirSync(reposDir).filter((r) => {
  const p = join(reposDir, r);
  try { return statSync(p).isDirectory(); } catch { return false; }
}).sort();

for (const repo of repos) {
  const wfDir = join(reposDir, repo, ".github", "workflows");
  if (!existsSync(wfDir)) continue;
  for (const file of readdirSync(wfDir).filter((f) => /\.ya?ml$/.test(f)).sort()) {
    const raw = readFileSync(join(wfDir, file), "utf8");
    let doc;
    try { doc = YAML.parse(raw); } catch (e) {
      records.push({ repo, workflow: file, job: "<parse-error>", error: String(e.message).split("\n")[0] });
      continue;
    }
    if (!doc || typeof doc !== "object") continue;
    const on = doc.on ?? doc[true]; // YAML 1.1 "on" may parse as boolean key
    const trig = triggers(on);
    const reusable = trig.includes("workflow_call");
    const jobs = doc.jobs ?? {};
    for (const [jobId, job] of Object.entries(jobs)) {
      const text = YAML.stringify(job);
      const steps = asList(job.steps);
      const uses = steps.map((s) => s?.uses).filter(Boolean);
      records.push({
        repo,
        workflow: file,
        workflowName: doc.name ?? file,
        job: jobId,
        triggers: trig,
        reusable,
        callsReusable: typeof job.uses === "string" ? job.uses : null,
        needs: asList(job.needs),
        runsOn: job["runs-on"] ?? null,
        matrix: job.strategy?.matrix ? Object.keys(job.strategy.matrix).filter((k) => k !== "include" && k !== "exclude") : [],
        matrixSize: matrixSize(job.strategy?.matrix),
        timeoutMinutes: job["timeout-minutes"] ?? null,
        environment: typeof job.environment === "string" ? job.environment : job.environment?.name ?? null,
        permissions: job.permissions ?? doc.permissions ?? null,
        services: job.services ? Object.keys(job.services) : [],
        container: job.container ? (typeof job.container === "string" ? job.container : job.container.image) : null,
        secrets: collect(SECRET_RE, text),
        vars: collect(VARS_RE, text),
        actions: [...new Set(uses.map((u) => u.split("@")[0]))].sort(),
        stepCount: steps.length,
        toolchains: toolchains(text),
        capabilities: capabilities(resolveRunsOn(job), text),
        destinations: destinations(text),
        uploadsArtifacts: uses.some((u) => u.startsWith("actions/upload-artifact")),
        usesCache: uses.some((u) => /actions\/cache|Swatinem\/rust-cache|setup-node/.test(u)) && /cache/.test(text),
      });
    }
  }
}

// When runs-on is a matrix expression, the real runner labels live in the matrix.
function resolveRunsOn(job) {
  const ro = job["runs-on"];
  if (typeof ro === "string" && ro.includes("matrix") && job.strategy?.matrix) return [ro, job.strategy.matrix];
  return ro;
}

function matrixSize(m) {
  if (!m || typeof m !== "object") return 1;
  if (typeof m === "string") return null; // dynamic matrix (fromJSON)
  let n = 1;
  for (const [k, v] of Object.entries(m)) {
    if (k === "include" || k === "exclude") continue;
    if (Array.isArray(v)) n *= v.length; else return null;
  }
  if (Array.isArray(m.include) && n === 1 && Object.keys(m).length === 1) n = m.include.length;
  return n;
}

if (opt("--json")) writeFileSync(opt("--json"), JSON.stringify(records, null, 2) + "\n");
if (opt("--md")) writeFileSync(opt("--md"), toMarkdown(records));
if (!opt("--json") && !opt("--md")) process.stdout.write(JSON.stringify(records, null, 2) + "\n");

function toMarkdown(rs) {
  const esc = (s) => String(s ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
  const lines = [
    "| Repository | Workflow | Job | Triggers | Needs | Runs on | Matrix | Capabilities | Toolchains | Secrets | Destinations | Artifacts |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|",
  ];
  for (const r of rs) {
    if (r.error) { lines.push(`| ${r.repo} | ${r.workflow} | PARSE ERROR | ${esc(r.error)} |||||||||`); continue; }
    lines.push([
      r.repo, r.workflow, r.callsReusable ? `${r.job} → ${r.callsReusable}` : r.job,
      r.triggers.join(", "), r.needs.join(", "), JSON.stringify(r.runsOn), r.matrixSize ?? "dynamic",
      r.capabilities.join(", "), r.toolchains.join(", "), r.secrets.join(", "), r.destinations.join(", "),
      r.uploadsArtifacts ? "yes" : "",
    ].map(esc).join(" | ").replace(/^/, "| ").replace(/$/, " |"));
  }
  return lines.join("\n") + "\n";
}
