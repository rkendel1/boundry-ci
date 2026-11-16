// The capability catalog: every operation Boundry knows how to perform, versioned.
// Recipes select capabilities by plain-language phrases; capabilities own their implementation
// (toolchain image, commands, network, resources), permissions and evidence contract.
// A capability's version changes whenever anything it executes changes; plans record the versions used.
import type { ProjectFacts, Ecosystem } from "./facts.ts";
import { realScript } from "./facts.ts";

export const CATALOG_VERSION = "boundry-capabilities/1.0.0";

export type Status = "implemented" | "partial" | "unavailable";
export type Kind = "trigger" | "check" | "step" | "approval" | "keep" | "after" | "project";

// ───────── toolchains (pinned images) ─────────
export interface Toolchain {
  id: string; label: string; image: string; imageDigest?: string; requires: string[];
  env: Record<string, string>; cache: { name: string; path: string; keyFiles: string[] }[];
  resources: { cpus: number; memoryMb: number; diskMb: number; pids: number }; timeoutMinutes: number;
  status: Status; note?: string;
}

export const TOOLCHAINS: Record<string, Toolchain> = {
  node: {
    id: "node22", label: "Node.js 22", status: "implemented",
    image: "mirror.gcr.io/library/node@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee",
    requires: ["linux-small"], env: { npm_config_cache: "/tmp/.npm", npm_config_update_notifier: "false" },
    cache: [{ name: "npm", path: "/tmp/.npm", keyFiles: [] }],
    resources: { cpus: 2, memoryMb: 3072, diskMb: 6144, pids: 2048 }, timeoutMinutes: 20,
  },
  bun: {
    id: "bun1.2", label: "Bun 1.2", status: "partial", note: "image pinned; not yet exercised on a real repository",
    image: "mirror.gcr.io/oven/bun@sha256:9654aa08d4b7e778b84148921bab8edc1409c8d0a85707b8c801dd7cf1878971",
    requires: ["linux-small"], env: { BUN_INSTALL_CACHE_DIR: "/tmp/.bun" }, cache: [{ name: "bun", path: "/tmp/.bun", keyFiles: [] }],
    resources: { cpus: 2, memoryMb: 3072, diskMb: 6144, pids: 2048 }, timeoutMinutes: 20,
  },
  rust: {
    id: "rust1", label: "Rust (stable, with rustfmt and clippy)", status: "implemented",
    image: "boundry-toolchain/rust:1", imageDigest: "sha256:add5bb0d051999904be90aa449f956c4b221dfe24ea0b3d668db66b95dbd3103",
    note: "built from deploy/toolchains/rust.Dockerfile (official rust:1-slim lacks rustfmt and clippy)",
    requires: ["linux-build"], env: { CARGO_HOME: "/tmp/cargo", CARGO_TERM_COLOR: "never", CARGO_INCREMENTAL: "0" },
    cache: [{ name: "cargo-registry", path: "/tmp/cargo/registry", keyFiles: ["Cargo.lock"] }],
    resources: { cpus: 2, memoryMb: 4096, diskMb: 8192, pids: 4096 }, timeoutMinutes: 45,
  },
  go: {
    id: "go1.23", label: "Go 1.23", status: "partial", note: "image pinned; not yet exercised on a real repository",
    image: "mirror.gcr.io/library/golang@sha256:167053a2bb901972bf2c1611f8f52c44d5fe7e762e5cab213708d82c421614db",
    requires: ["linux-build"], env: { GOPATH: "/tmp/go", GOCACHE: "/tmp/gocache", GOFLAGS: "-mod=readonly" },
    cache: [{ name: "go-mod", path: "/tmp/go/pkg/mod", keyFiles: ["go.sum"] }],
    resources: { cpus: 2, memoryMb: 4096, diskMb: 8192, pids: 4096 }, timeoutMinutes: 30,
  },
  python: {
    id: "python3.12", label: "Python 3.12", status: "partial", note: "tests via requirements.txt + pytest only; not yet exercised",
    image: "mirror.gcr.io/library/python@sha256:935c3c5b12357a7e10caa9c1e6ca5692344d97cf229832ef584be2cec9fc03df",
    requires: ["linux-small"], env: { PIP_CACHE_DIR: "/tmp/.pip", PYTHONUSERBASE: "/tmp/pyuser", PIP_DISABLE_PIP_VERSION_CHECK: "1" },
    cache: [{ name: "pip", path: "/tmp/.pip", keyFiles: ["requirements.txt"] }],
    resources: { cpus: 2, memoryMb: 3072, diskMb: 6144, pids: 2048 }, timeoutMinutes: 30,
  },
};

// ───────── implementations ─────────
export interface Impl {
  toolchain: Toolchain;
  install: string[]; // dependency installation (needs the internet)
  run: string[]; // the operation itself
  summary: string; // human: what runs, e.g. "runs `npm test`"
  needsNetwork: boolean;
}
export interface Unsupported { unsupported: string; status: Status }
export type Resolution = Impl | Unsupported;
export const isUnsupported = (r: Resolution): r is Unsupported => "unsupported" in r;

/** The project's primary toolchain and how to install its dependencies. */
export function toolchainFor(f: ProjectFacts, eco: Ecosystem): { tc: Toolchain; install: string[]; pmRun: (s: string) => string } | Unsupported {
  switch (eco) {
    case "node": {
      const n = f.node!;
      if (!n.lockfile) return { unsupported: "this Node project has no lockfile (package-lock.json, pnpm-lock.yaml or yarn.lock), so installs would not be reproducible. Commit a lockfile first.", status: "unavailable" };
      if (!n.packageManager) return { unsupported: `this project has more than one lockfile (${n.lockfile}). Say which tool to use under About this project, e.g. "Use npm".`, status: "unavailable" };
      const cacheKey = (tc: Toolchain) => ({ ...tc, cache: tc.cache.map((c) => ({ ...c, keyFiles: [n.lockfile!] })) });
      if (n.packageManager === "npm") return { tc: cacheKey(TOOLCHAINS.node), install: ["npm ci --no-audit --no-fund"], pmRun: (s) => (s === "test" ? "npm test" : `npm run ${s}`) };
      if (n.packageManager === "pnpm") return { tc: { ...cacheKey(TOOLCHAINS.node), status: "partial", note: "pnpm via corepack; not yet exercised" }, install: ["corepack enable --install-directory /tmp/bin", "PATH=/tmp/bin:$PATH COREPACK_HOME=/tmp/corepack pnpm install --frozen-lockfile"], pmRun: (s) => `PATH=/tmp/bin:$PATH COREPACK_HOME=/tmp/corepack pnpm run ${s}` };
      if (n.packageManager === "yarn") return { unsupported: "Yarn projects are not supported yet (classic and Berry need different install commands). Add support to the catalog, or use npm.", status: "unavailable" };
      return { unsupported: "unreachable", status: "unavailable" };
    }
    case "bun": {
      const n = f.node!;
      return { tc: { ...TOOLCHAINS.bun, cache: TOOLCHAINS.bun.cache.map((c) => ({ ...c, keyFiles: [n.lockfile!] })) }, install: ["bun install --frozen-lockfile"], pmRun: (s) => (s === "test" ? "bun test" : `bun run ${s}`) };
    }
    case "rust":
      if (!f.rust!.lockfile) return { unsupported: "this Rust project has no Cargo.lock, so builds would not be reproducible. Commit Cargo.lock first.", status: "unavailable" };
      return { tc: TOOLCHAINS.rust, install: ["cargo fetch --locked"], pmRun: (s) => s };
    case "go":
      return { tc: TOOLCHAINS.go, install: ["go mod download"], pmRun: (s) => s };
    case "python":
      if (!f.python!.requirements) return { unsupported: "only Python projects with requirements.txt are supported so far.", status: "unavailable" };
      return { tc: TOOLCHAINS.python, install: ["pip install --user -r requirements.txt"], pmRun: (s) => s };
    case "zig":
      return { unsupported: "there is no Boundry toolchain image for Zig yet.", status: "unavailable" };
  }
}

const node = (eco: Ecosystem) => eco === "node" || eco === "bun";
const scriptOr = (f: ProjectFacts, names: string[]) => names.find((s) => realScript(f, s)) ?? null;

type Implement = (f: ProjectFacts, eco: Ecosystem, t: { tc: Toolchain; install: string[]; pmRun: (s: string) => string }) => { run: string[]; summary: string; status?: Status; install?: false } | Unsupported;

export interface Capability {
  id: string; version: string; kind: Kind; title: string;
  phrases: string[]; // matched against normalized text; {slot} captures a word, {path} a `code` span
  status: Status; note?: string;
  permissions?: ("release" | "deploy")[]; secrets?: string[];
  evidence: string[];
  implement?: Implement;
  /** For keep: which artifact it keeps and which capability produces it. */
  keeps?: { artifact: string; producedBy: string[]; always?: boolean };
  input?: string; // consumes the artifact of an earlier step (by artifact file name)
  output?: string; // produces this artifact
}

/** Outcomes too vague to check; each answer points at concrete checks instead of guessing. */
export const VAGUE_SUGGESTIONS = ["The tests pass", "There are no type errors", "The application builds", "The linter passes"];
export const VAGUE: Record<string, string> = {
  "nothing important breaks": "Boundry can't check “nothing important breaks” on its own — say which outcomes matter",
  "nothing breaks": "Boundry can't check “nothing breaks” on its own — say which outcomes matter",
  "everything works": "Boundry can't check “everything works” on its own — say which outcomes matter",
  "it works": "Boundry can't check “it works” on its own — say which outcomes matter",
  "result is safe to merge": "a change is reported safe to merge when every item under Make sure passes, so list those items instead",
  "it is safe to merge": "a change is reported safe to merge when every item under Make sure passes, so list those items instead",
  "change is safe to merge": "a change is reported safe to merge when every item under Make sure passes, so list those items instead",
};

export const CAPABILITIES: Capability[] = [
  // ── when ──
  { id: "trigger.change-proposed", version: "1.0.0", kind: "trigger", status: "implemented", title: "A change is proposed (pull request opened or updated)",
    phrases: ["someone proposes change", "change is proposed", "someone opens or updates pull request", "pull request is opened or updated", "someone proposes changes"], evidence: ["source event"] },
  { id: "trigger.branch-updated", version: "1.0.0", kind: "trigger", status: "implemented", title: "A branch receives new commits",
    phrases: ["{branch} branch is updated", "someone updates {branch} branch", "updates {branch} branch", "changes reach {branch}", "changes reach {branch} branch", "something is pushed to {branch}", "{branch} branch changes"], evidence: ["source event"] },
  { id: "trigger.version-tagged", version: "1.0.0", kind: "trigger", status: "implemented", title: "A version tag (v…) is pushed",
    phrases: ["version is tagged", "new version is tagged", "someone tags version", "someone tags new version"], evidence: ["source event"] },
  { id: "trigger.manual", version: "1.0.0", kind: "trigger", status: "implemented", title: "An authorized person starts it",
    phrases: ["i approve release", "i start it", "someone starts it", "i ask for it", "i ask for release", "someone asks for it"], evidence: ["operator identity"] },
  { id: "trigger.schedule", version: "1.0.0", kind: "trigger", status: "implemented", title: "On a schedule (UTC)",
    phrases: ["every day at {time} utc", "every night", "every {weekday} at {time} utc"], evidence: ["schedule slot"] },

  // ── make sure (checks) ──
  { id: "check.builds", version: "1.0.0", kind: "check", status: "implemented", title: "The project builds", output: "build-output.tar",
    phrases: ["application builds", "project builds", "it builds", "code builds", "build succeeds", "code compiles", "application compiles"],
    evidence: ["exit status", "log", "build output (if kept)"],
    implement: (f, eco, t) => {
      if (node(eco)) { const s = scriptOr(f, ["build"]); return s ? { run: [t.pmRun(s)], summary: `runs \`${t.pmRun(s)}\`` } : { unsupported: "package.json has no \"build\" script, so there is nothing to build. Add one, or remove this line.", status: "unavailable" }; }
      if (eco === "rust") return { run: ["cargo build --locked --release --all-targets"], summary: "runs `cargo build --locked --release`" };
      if (eco === "go") return { run: ["go build ./..."], summary: "runs `go build ./...`", status: "partial" };
      return { unsupported: `building ${eco} projects is not supported yet`, status: "unavailable" };
    } },
  { id: "check.tests", version: "1.0.0", kind: "check", status: "implemented", title: "The tests pass", output: "test-results.txt",
    phrases: ["tests pass", "all tests pass", "unit tests pass", "test suite passes", "full test suite passes", "tests succeed"],
    evidence: ["exit status", "log", "test runner output (if kept, even when tests fail)"],
    implement: (f, eco, t) => {
      if (node(eco)) return realScript(f, "test") ? { run: [t.pmRun("test")], summary: `runs \`${t.pmRun("test")}\`` } : { unsupported: "package.json has no real \"test\" script. Add one, or remove this line.", status: "unavailable" };
      if (eco === "rust") return { run: ["cargo test --locked"], summary: "runs `cargo test --locked`" };
      if (eco === "go") return { run: ["go test ./..."], summary: "runs `go test ./...`", status: "partial" };
      if (eco === "python") return { run: ["python -m pytest"], summary: "runs `python -m pytest`", status: "partial" };
      return { unsupported: `testing ${eco} projects is not supported yet`, status: "unavailable" };
    } },
  { id: "check.types", version: "1.0.0", kind: "check", status: "implemented", title: "There are no type errors",
    phrases: ["types check", "type check passes", "there are no type errors", "types are correct", "typescript types check"], evidence: ["exit status", "log"],
    implement: (f, eco, t) => {
      if (!node(eco)) return { unsupported: `type checking is part of building for ${eco}; use “The application builds”`, status: "unavailable" };
      const s = scriptOr(f, ["typecheck", "type-check", "check-types", "types"]);
      return s ? { run: [t.pmRun(s)], summary: `runs \`${t.pmRun(s)}\`` } : { unsupported: "package.json has no \"typecheck\" script. Add one (e.g. \"tsc --noEmit\"), or remove this line.", status: "unavailable" };
    } },
  { id: "check.formatted", version: "1.0.0", kind: "check", status: "implemented", title: "The code is formatted",
    phrases: ["code is formatted", "formatting is correct", "code is formatted correctly", "code is consistently formatted"], evidence: ["exit status", "log"],
    implement: (f, eco, t) => {
      if (eco === "rust") return { run: ["cargo fmt --all -- --check"], summary: "runs `cargo fmt --check`", install: false };
      if (eco === "go") return { run: ['test -z "$(gofmt -l .)"'], summary: "checks `gofmt -l` reports nothing", status: "partial", install: false };
      if (node(eco)) { const s = scriptOr(f, ["format:check", "fmt:check", "prettier:check", "check-format"]); return s ? { run: [t.pmRun(s)], summary: `runs \`${t.pmRun(s)}\`` } : { unsupported: "package.json has no \"format:check\" script. Add one, or remove this line.", status: "unavailable" }; }
      return { unsupported: `format checking for ${eco} is not supported yet`, status: "unavailable" };
    } },
  { id: "check.lint", version: "1.0.0", kind: "check", status: "implemented", title: "The linter passes",
    phrases: ["linter passes", "lint passes", "linting passes", "there are no lint warnings", "code passes linter", "there are no linter warnings"], evidence: ["exit status", "log"],
    implement: (f, eco, t) => {
      if (eco === "rust") return { run: ["cargo clippy --locked --all-targets --all-features -- -D warnings"], summary: "runs `cargo clippy` with warnings treated as errors" };
      if (eco === "go") return { run: ["go vet ./..."], summary: "runs `go vet ./...`", status: "partial" };
      if (node(eco)) { const s = scriptOr(f, ["lint"]); return s ? { run: [t.pmRun(s)], summary: `runs \`${t.pmRun(s)}\`` } : { unsupported: "package.json has no \"lint\" script. Add one, or remove this line.", status: "unavailable" }; }
      return { unsupported: `linting ${eco} is not supported yet`, status: "unavailable" };
    } },
  { id: "check.dependencies", version: "1.0.0", kind: "check", status: "partial", note: "npm only (npm audit, high severity, production dependencies)",
    title: "Dependencies have no known high-severity vulnerabilities",
    phrases: ["dependencies have no known vulnerabilities", "dependencies are safe", "there are no known vulnerable dependencies", "dependencies have no known security problems"], evidence: ["exit status", "audit report in log"],
    implement: (f, eco) => (eco === "node" && f.node?.packageManager === "npm")
      ? { run: ["npm audit --audit-level=high --omit=dev"], summary: "runs `npm audit` (high severity, production dependencies)" }
      : { unsupported: `dependency vulnerability checks are only available for npm projects so far (this is ${eco})`, status: "unavailable" } },
  { id: "check.browser", version: "1.0.0", kind: "check", status: "unavailable", title: "Browser tests pass",
    note: "needs a browser toolchain image matched to the project's Playwright version", phrases: ["browser tests pass", "end to end tests pass", "e2e tests pass"], evidence: [],
    implement: () => ({ unsupported: "browser tests are not available yet: Boundry has no browser toolchain matched to your Playwright version", status: "unavailable" }) },

  // ── steps (ordered) ──
  { id: "step.build", version: "1.0.0", kind: "step", status: "implemented", title: "Build", output: "build-output.tar",
    phrases: ["build application", "build project", "build it", "build code"], evidence: ["exit status", "log"],
    implement: (f, e, t) => CAPABILITIES.find((c) => c.id === "check.builds")!.implement!(f, e, t) },
  { id: "step.tests", version: "1.0.0", kind: "step", status: "implemented", title: "Run the tests", output: "test-results.txt",
    phrases: ["run tests", "run full test suite", "run all tests", "test application", "run test suite"], evidence: ["exit status", "log"],
    implement: (f, e, t) => CAPABILITIES.find((c) => c.id === "check.tests")!.implement!(f, e, t) },
  { id: "step.package", version: "1.0.0", kind: "step", status: "implemented", title: "Package the result", output: "package.tar",
    phrases: ["package result", "package application", "create package", "package it", "package project"], evidence: ["package.tar (sha256 recorded)", "log"],
    implement: (f, eco, t) => {
      if (eco === "node") {
        const pack = f.node!.workspaces ? "npm pack --workspaces --pack-destination boundry-out/pkg" : "npm pack --pack-destination boundry-out/pkg";
        const build = realScript(f, "build") ? [t.pmRun("build")] : [];
        if (f.node!.packageManager !== "npm") return { unsupported: "packaging is implemented for npm projects only so far", status: "unavailable" };
        return { run: [...build, "mkdir -p boundry-out/pkg", `${pack} > /dev/null`, "ls boundry-out/pkg"], summary: `${build.length ? `runs \`${build[0]}\`, then ` : ""}\`${pack.split(" --pack")[0]}\`` };
      }
      if (eco === "rust") return { run: ["cargo build --locked --release", "mkdir -p boundry-out/pkg", "find target/release -maxdepth 1 -type f -perm -u+x -exec cp {} boundry-out/pkg/ \\;", "ls boundry-out/pkg"], summary: "runs `cargo build --release` and collects the executables" };
      return { unsupported: `packaging ${eco} projects is not supported yet`, status: "unavailable" };
    } },
  { id: "step.verify-package", version: "1.0.0", kind: "step", status: "implemented", title: "Verify the package", input: "package.tar", output: "release-manifest.txt",
    phrases: ["verify package", "check package contents", "verify release package", "verify packaged result"], evidence: ["input digest verified by the worker", "release-manifest.txt"],
    implement: () => ({ run: ["mkdir -p boundry-out", "tar -tvf boundry-in/package.tar", "{ echo \"package.tar sha256 $(sha256sum boundry-in/package.tar | cut -d' ' -f1)\"; tar -tf boundry-in/package.tar; } > boundry-out/release-manifest.txt", "cat boundry-out/release-manifest.txt"], summary: "lists the package contents and records its digest" }) },
  { id: "step.publish-npm", version: "1.0.0", kind: "step", status: "partial", note: "implemented; never exercised against the npm registry",
    title: "Publish the package to npm", input: "package.tar", permissions: ["release"], secrets: ["NPM_TOKEN"],
    phrases: ["publish package to npm", "publish to npm", "publish it to npm"], evidence: ["published tarballs' digests", "registry response in log"],
    implement: (f, eco) => eco === "node" ? {
      run: ["mkdir -p /tmp/pub && tar -xf boundry-in/package.tar -C /tmp/pub", "printf '//registry.npmjs.org/:_authToken=%s\\n' \"$NPM_TOKEN\" > /tmp/.npmrc", "for t in /tmp/pub/*.tgz; do sha256sum \"$t\"; NPM_CONFIG_USERCONFIG=/tmp/.npmrc npm publish \"$t\" --access public; done"],
      summary: "publishes exactly the packaged tarballs (by digest) with the repository's NPM_TOKEN" } : { unsupported: "npm publishing applies to Node projects only", status: "unavailable" } },
  { id: "step.publish-github-release", version: "1.0.0", kind: "step", status: "unavailable", title: "Create a GitHub release",
    note: "the Boundry CI GitHub App has no contents:write permission by design", phrases: ["create github release", "publish github release", "publish release on github"], evidence: [] },
  { id: "step.deploy", version: "1.0.0", kind: "step", status: "unavailable", title: "Deploy an approved artifact",
    note: "AppBoundry deployment integration is designed but not implemented", phrases: ["deploy application", "deploy update", "deploy it", "deploy to appboundry"], evidence: [] },
  { id: "step.verify-deployment", version: "1.0.0", kind: "step", status: "unavailable", title: "Verify a deployment", note: "depends on step.deploy", phrases: ["verify deployment", "check deployment is healthy"], evidence: [] },
  { id: "approval.person", version: "1.0.0", kind: "approval", status: "implemented", title: "A named person approves before the next step",
    phrases: ["ask {person} to approve", "ask {person} to approve release", "wait for {person} to approve", "wait for {person} to approve release", "get approval from {person}"], evidence: ["approver identity and time", "plan digest at approval"] },

  // ── keep ──
  { id: "keep.build-output", version: "1.0.0", kind: "keep", status: "implemented", title: "The build output", keeps: { artifact: "build-output.tar", producedBy: ["check.builds", "step.build"] },
    phrases: ["build output", "built application", "build result", "build artifacts"], evidence: ["content-addressed artifact"] },
  { id: "keep.test-results", version: "1.0.0", kind: "keep", status: "implemented", title: "The test results (test runner output, also when tests fail)", keeps: { artifact: "test-results.txt", producedBy: ["check.tests", "step.tests"], always: true },
    phrases: ["test results", "test output", "test report"], evidence: ["content-addressed artifact"] },
  { id: "keep.package", version: "1.0.0", kind: "keep", status: "implemented", title: "The package", keeps: { artifact: "package.tar", producedBy: ["step.package"] },
    phrases: ["package", "release package", "packaged result"], evidence: ["content-addressed artifact"] },
  { id: "keep.evidence", version: "1.0.0", kind: "keep", status: "implemented", title: "A record of what was checked (recipe, plan, results) — always kept",
    phrases: ["record of what was checked", "release evidence", "record of what happened", "evidence", "record of what was done"], evidence: ["recipe source, compiled plan, facts, attempts, artifacts in FeltDB"] },

  // ── afterward ──
  { id: "after.report", version: "1.0.0", kind: "after", status: "implemented", title: "Report the result as commit statuses",
    phrases: ["report result on change", "report result", "report outcome", "report result on commit", "report outcome on change"], evidence: ["status outbox delivery record"] },
  { id: "after.notify", version: "1.0.0", kind: "after", status: "unavailable", title: "Notify someone", note: "no notification channel exists yet",
    phrases: ["tell {person}", "notify {person}", "email {person}", "send message to {person}", "let {person} know"], evidence: [] },

  // ── about this project ──
  { id: "project.ecosystem", version: "1.0.0", kind: "project", status: "implemented", title: "Kind of project",
    phrases: ["this is {ecosystem} project", "it is {ecosystem} project", "this is {ecosystem} application"], evidence: [] },
  { id: "project.dir", version: "1.0.0", kind: "project", status: "implemented", title: "Where the project lives",
    phrases: ["application is in {path}", "project is in {path}", "code is in {path}"], evidence: [] },
  { id: "project.output", version: "1.0.0", kind: "project", status: "implemented", title: "Where the build output is",
    phrases: ["build output is in {paths}"], evidence: [] },
  { id: "project.tool", version: "1.0.0", kind: "project", status: "implemented", title: "Package manager",
    phrases: ["use {tool}"], evidence: [] },
];

export const capability = (id: string) => CAPABILITIES.find((c) => c.id === id)!;

// ───────── phrase matching ─────────
const SLOT: Record<string, string> = {
  branch: "([a-z0-9][a-z0-9._/-]*)", person: "([a-z0-9][a-z0-9_-]*)", time: "([0-2]?\\d:[0-5]\\d)",
  weekday: "(monday|tuesday|wednesday|thursday|friday|saturday|sunday)", ecosystem: "(node\\.?js|node|javascript|typescript|rust|go|golang|python|bun|zig)",
  path: "`([^`]+)`", paths: "(`[^`]+`(?:\\s*(?:,|and)\\s*`[^`]+`)*)", tool: "(npm|pnpm|yarn|bun)",
};
const compiled = new Map<string, RegExp>();
function regexOf(phrase: string): RegExp {
  let r = compiled.get(phrase);
  if (!r) {
    const src = phrase.split(/(\{[a-z]+\})/).map((p) => { const m = /^\{([a-z]+)\}$/.exec(p); return m ? SLOT[m[1]] : p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }).join("");
    r = new RegExp(`^${src}$`, "i");
    compiled.set(phrase, r);
  }
  return r;
}

export interface Match { cap: Capability; slots: string[] }
export function matchPhrase(kind: Kind | Kind[], text: string): Match | null {
  const kinds = Array.isArray(kind) ? kind : [kind];
  for (const cap of CAPABILITIES) {
    if (!kinds.includes(cap.kind)) continue;
    for (const ph of cap.phrases) {
      const m = regexOf(ph).exec(text);
      if (m) return { cap, slots: m.slice(1) };
    }
  }
  return null;
}

/** Deterministic suggestions: the closest known phrases by shared words. */
export function suggest(kind: Kind | Kind[], text: string, n = 3): string[] {
  const kinds = Array.isArray(kind) ? kind : [kind];
  const words = new Set(text.split(/\s+/));
  const scored: [number, string][] = [];
  for (const cap of CAPABILITIES) {
    if (!kinds.includes(cap.kind) || cap.status === "unavailable") continue;
    const ph = cap.phrases[0];
    const pw = ph.split(/\s+/);
    const shared = pw.filter((w) => words.has(w)).length;
    scored.push([shared / new Set([...pw, ...words]).size, sayOf(cap)]);
  }
  return scored.sort((a, b) => b[0] - a[0] || a[1].localeCompare(b[1])).slice(0, n).map(([, p]) => p);
}

// How each capability is written in a recipe (the canonical, natural wording shown in suggestions and docs).
export const SAY: Record<string, string> = {
  "trigger.change-proposed": "Someone proposes a change", "trigger.branch-updated": "The main branch is updated", "trigger.version-tagged": "A version is tagged",
  "trigger.manual": "I start it", "trigger.schedule": "Every day at 06:00 UTC",
  "check.builds": "The application builds", "check.tests": "The tests pass", "check.types": "There are no type errors", "check.formatted": "The code is formatted",
  "check.lint": "The linter passes", "check.dependencies": "Dependencies have no known vulnerabilities", "check.browser": "Browser tests pass",
  "step.build": "Build the application", "step.tests": "Run the full test suite", "step.package": "Package the result", "step.verify-package": "Verify the package",
  "step.publish-npm": "Publish the package to npm", "step.publish-github-release": "Create a GitHub release", "step.deploy": "Deploy the application",
  "step.verify-deployment": "Verify the deployment", "approval.person": "Ask Sam to approve the release",
  "keep.build-output": "The build output", "keep.test-results": "The test results", "keep.package": "The package", "keep.evidence": "A record of what was checked",
  "after.report": "Report the result on the change", "after.notify": "Tell Sam",
  "project.ecosystem": "This is a Rust project", "project.dir": "The application is in `app`", "project.output": "The build output is in `dist`", "project.tool": "Use npm",
};
export const sayOf = (c: Capability) => SAY[c.id] ?? display(c.phrases[0]);

/** A phrase as a person would write it. */
export function display(phrase: string): string {
  const s = phrase.replace("{branch}", "main").replace("{person}", "Sam").replace("{time}", "06:00").replace("{weekday}", "Monday").replace("{ecosystem}", "Rust").replace("{path}", "`app`").replace("{paths}", "`dist`").replace("{tool}", "npm");
  return s.charAt(0).toUpperCase() + s.slice(1);
}
