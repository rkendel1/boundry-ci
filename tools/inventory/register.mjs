#!/usr/bin/env node
// Builds docs/migration-register.md from workflow-jobs.json (parsed workflow YAML),
// actions-usage-30d.json (measured job timings) and the repository classification below.
// Deterministic: same inputs -> same output.
import { readFileSync, writeFileSync } from "node:fs";

const jobs = JSON.parse(readFileSync("docs/discovery/workflow-jobs.json", "utf8"));
const usage = JSON.parse(readFileSync("docs/discovery/actions-usage-30d.json", "utf8"));

// Classification is evidence-based where noted; "confirm" marks owner decisions.
const REPOS = {
  flow_db:               { vis: "private", stage: 2, role: "FeltDB (Rust server + TS SDK)" },
  feltkit:               { vis: "private", stage: 2, role: "FeltKit" },
  appport:               { vis: "private", stage: 2, role: "AppPort" },
  "appport-services":    { vis: "public",  stage: 2, role: "AppPort Services" },
  resolver:              { vis: "public",  stage: 2, role: "Resolver (deployed on Hetzner :21020)" },
  appworks:              { vis: "public",  stage: 2, role: "AppWorks" },
  "stack-ui":            { vis: "public",  stage: 2, role: "Stack UI" },
  appboundry:            { vis: "private", stage: 3, role: "AppBoundry (Hetzner deploy conventions, images)" },
  authboundry:           { vis: "private", stage: 3, role: "AuthBoundry (needs macOS for cli-smoke/release)" },
  "chip-rs":             { vis: "public",  stage: 3, role: "Chip" },
  fx:                    { vis: "public",  stage: 3, role: "FX (Zig; macOS + arm64 matrix)" },
  compute:               { vis: "public",  stage: 3, role: "Compute (Chip/FX integration, microVM)" },
  "stack-agent":         { vis: "public",  stage: 3, role: "Stack Agent" },
  "distribution-protocol": { vis: "public", stage: 3, role: "Distribution Protocol" },
  pax:                   { vis: "public",  stage: 3, role: "PAX" },
  "wasm-agent-env":      { vis: "public",  stage: 3, role: "WASM agent env" },
  boundry:               { vis: "public",  stage: 2, role: "Boundry" },
  "boundry-intel":       { vis: "public",  stage: 2, role: "Boundry Intel (deployed on Hetzner :21010)" },
  "boundry-maint":       { vis: "public",  stage: 4, role: "Boundry maintenance (scheduled scan, Pages)" },
  "stack-intel":         { vis: "private", stage: 4, role: "Stack Intel (scheduled publish)" },
  "felt-ops":            { vis: "public",  stage: 3, role: "Felt ops / runbooks" },
  "felt-session":        { vis: "public",  stage: 4, role: "Felt Session (macOS/iOS/TestFlight/Chrome releases) — confirm active" },
  "homebrew-compute":    { vis: "public",  stage: 4, role: "Homebrew tap (hourly sync)" },
  personalOS:            { vis: "public",  stage: 4, role: "personalOS (iOS) — confirm in scope" },
  "supply-desk":         { vis: "public",  stage: 2, role: "Supply Desk — confirm in scope" },
  tableOS:               { vis: "public",  stage: 2, role: "tableOS — confirm in scope" },
  OpenDotsFeltDB:        { vis: "public",  stage: 2, role: "OpenDotsFeltDB — confirm active" },
  "2fx":                 { vis: "public",  stage: 3, role: "2fx (earlier FX line?) — confirm active" },
  "3fx":                 { vis: "public",  stage: 3, role: "3fx (earlier FX line?) — confirm active" },
};

// Owner decisions (2026-11-16): recorded here so the register is regenerated from them, not hand-edited.
const DECISIONS = {
  excluded: { feltgit: "Git fork carrying upstream Git workflows; not a Boundry product workload" },
  publicRepos: "deferred: stays on GitHub Actions (public repos run free there); move only when capacity or independence justifies it",
  macos: "deferred: classify whether native macOS execution is genuinely necessary; no Mac worker until the deployment is stable",
  windows: "stays on its existing execution path",
  privateNote: "inventory entry, not yet a confirmed product requirement",
};

const wfUsage = (repo, wf) => usage.repos?.[repo]?.workflows?.[`.github/workflows/${wf}`] ?? null;

function status(j, cls) {
  if (j.error) return "blocked: workflow YAML does not parse (fails on GitHub too)";
  if (j.capabilities.includes("windows")) return DECISIONS.windows;
  if (j.capabilities.some((c) => c.startsWith("macos"))) return DECISIONS.macos;
  if (cls.vis === "public") return "deferred: public (free on GitHub Actions)";
  if (j.capabilities.includes("deploy") || j.capabilities.includes("release")) return "candidate, stage 4 (release/deploy path)";
  return "candidate (private, billed) — not migrated in this slice";
}

function acceptance(j) {
  const t = [];
  if (j.destinations.length) t.push(`published output equivalent (${j.destinations.join("/")}) verified by digest`);
  if (j.uploadsArtifacts) t.push("artifacts content-addressed and retrievable");
  if (j.triggers.some((x) => x.startsWith("schedule"))) t.push("fires on schedule; missed slot recovered once");
  if (!t.length) t.push("same pass/fail on same commit as GHA for 5 consecutive commits");
  return t.join("; ");
}

const excludedJobs = jobs.filter((j) => DECISIONS.excluded[j.repo]);
jobs.splice(0, jobs.length, ...jobs.filter((j) => !DECISIONS.excluded[j.repo]));
const esc = (s) => String(s ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
const L = [];
L.push("# Boundry CI migration register", "");
L.push("Generated by `tools/inventory/register.mjs` from parsed workflow YAML (`docs/discovery/workflow-jobs.json`) and measured job timings (`docs/discovery/actions-usage-30d.json`). Do not edit by hand.", "");
L.push(`Coverage: ${new Set(jobs.map((j) => j.repo)).size} repositories, ${new Set(jobs.map((j) => j.repo + "/" + j.workflow)).size} workflows, ${jobs.length} jobs. Durations are measured only for private repositories (the only ones whose Actions API this session could read); public repositories show "n/m" (not measured).`, "");
L.push("## Decisions applied", "");
L.push(`- **Excluded:** ${Object.entries(DECISIONS.excluded).map(([r, why]) => `\`${r}\` (${excludedJobs.filter((j) => j.repo === r).length} jobs) — ${why}`).join("; ")}.`);
L.push(`- **Public repositories:** ${DECISIONS.publicRepos}.`);
L.push(`- **macOS jobs:** ${DECISIONS.macos}.`);
L.push(`- **Windows jobs:** ${DECISIONS.windows}.`);
L.push(`- **Private repositories:** every row is an ${DECISIONS.privateNote}. No workflow is migrated in the deployment-readiness slice.`, "");
const counts = {};
for (const j of jobs) { const st = status(j, REPOS[j.repo] ?? {}); counts[st] = (counts[st] ?? 0) + 1; }
L.push("| Status | Jobs |", "|---|---|", ...Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([k, v]) => `| ${esc(k)} | ${v} |`), "");
L.push("## Repositories", "");
L.push("| Repository | Visibility | Stage | Role | Workflows | Jobs | 30-day job minutes (measured) |", "|---|---|---|---|---|---|---|");
for (const repo of Object.keys(REPOS).sort()) {
  const js = jobs.filter((j) => j.repo === repo);
  const u = usage.repos?.[repo];
  const mins = u ? `${Math.round(u.minutes.linux)} linux, ${Math.round(u.minutes.macos)} macOS` : "n/m";
  L.push(`| ${repo} | ${REPOS[repo].vis} | ${REPOS[repo].stage ?? "—"} | ${esc(REPOS[repo].role)} | ${new Set(js.map((j) => j.workflow)).size} | ${js.length} | ${mins} |`);
}
L.push("", "## Jobs", "");
L.push("| Repository | Workflow | Job | Trigger | Needs | Capabilities | Toolchain | Secrets | Destinations | Artifacts | Avg / max min (30d) | Migration status | Acceptance test |");
L.push("|---|---|---|---|---|---|---|---|---|---|---|---|---|");
for (const j of [...jobs].sort((a, b) => (a.repo + a.workflow + a.job).localeCompare(b.repo + b.workflow + b.job))) {
  const cls = REPOS[j.repo] ?? { stage: null };
  if (j.error) { L.push(`| ${j.repo} | ${j.workflow} | — | — | — | — | — | — | — | — | — | ${status(j, cls)} | fix YAML (${esc(j.error)}) |`); continue; }
  const u = wfUsage(j.repo, j.workflow);
  L.push(`| ${[
    j.repo, j.workflow, j.callsReusable ? `${j.job} → ${j.callsReusable}` : j.job, j.triggers.join(", "), j.needs.join(", "),
    j.capabilities.join(", ") + (j.matrixSize === null ? " (dynamic matrix)" : j.matrixSize > 1 ? ` ×${j.matrixSize}` : ""),
    j.toolchains.join(", "), j.secrets.join(", "), j.destinations.join(", "), j.uploadsArtifacts ? "yes" : "",
    u ? `${u.avgJobMin} / ${u.maxJobMin}` : "n/m", status(j, cls), acceptance(j),
  ].map(esc).join(" | ")} |`);
}
writeFileSync("docs/migration-register.md", L.join("\n") + "\n");
console.log(`wrote docs/migration-register.md (${jobs.length} jobs)`);
