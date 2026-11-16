# Boundry Recipes — slice 3 record

> **Architecture correction (2026-11-16):** recipes, the capability catalog and release decisions belong to
> **Boundry Maintenance** (`rkendel1/boundry-maint`), the existing ecosystem authority. This repository's
> recipe code is the proven prototype; Boundry CI remains the *execution* substrate (scheduler, workers,
> isolation, artifacts, approvals, attempts). Ownership moves in the Maintenance slice; nothing here should grow
> into a second authority.

## What exists (in this repository)

| Piece | Code |
|---|---|
| Recipe format (Markdown sections: When this happens / Make sure / Steps / Keep / Afterward / About this project / Custom checks) | `src/recipes/parse.ts` |
| Capability catalog `boundry-capabilities/1.0.1` (31 capabilities, implemented / partial / unavailable) | `src/recipes/catalog.ts` · `boundry-ci recipe capabilities` |
| Project facts (read files only, never run them) | `src/recipes/facts.ts` |
| Deterministic compiler `boundry-recipes/1.0.0` → the engine's existing plan type | `src/recipes/compile.ts` |
| Explanation and reviewable plan diff | `src/recipes/explain.ts` · `recipe explain` / `recipe diff` |
| Guided authoring (inspects the repo, offers only checks that work, asks when ambiguous) | `src/recipes/author.ts` · `recipe new` |
| Legacy conversion with translated / decision / unsupported / behaviour-change report | `src/recipes/convert.ts` · `recipe convert` |
| Engine integration: one run per matching recipe; recipe, facts, plan, explanation recorded; statuses only when asked; artifact inputs by digest; keep-on-failure artifacts; image digest check; `/v1/runs/:id/evidence` | `src/control/*`, `src/worker/*` |

Tests: `test/recipes.test.ts` (R1–R11) — determinism, vague-outcome refusal, approval/permission rules, unavailable
capabilities, project ambiguity, nothing-added-silently, plan diffs, trigger matching, intake and artifact inputs on a real FeltDB.

## Real executions (existing engine, real commits checked out from github.com, real containers)

Recipe files were overlaid (this session cannot commit to those repositories); repository content and commits are real.
Evidence: `docs/recipes/evidence/*.json` (run, trigger, recipe source by digest, plan, every attempt, log tails, artifacts re-verified).

| Example | Commit | Result | What it proves |
|---|---|---|---|
| `resolver` (Node, `examples/recipes/resolver/check.md`) | `aaab053` | **succeeded** in 39 s: build (798 KB output kept), 207 tests passed, type check | simple recipe, parallel checks on two workers, artifacts, statuses |
| `pax` (Rust, `examples/recipes/pax/check.md`) at `main` | `aab5039` | **failed correctly**: `main` does not compile (12 errors after a merge of two PRs adding the same feature) and is not rustfmt-clean | real breakage detected; test results kept on failure |
| `pax` at `v0.5.0` | `c3fb3b4` | build, fmt, clippy **succeeded**; 45/46 tests passed | the 1 failure needs `npm` at test time (GitHub's runner preinstalls it; Boundry's Rust toolchain doesn't). Multi-toolchain jobs are not supported yet. |
| `distribution-protocol` (`release.md`: 4 parallel checks incl. 3 custom, package, verify, approval, publish) | `19d5795` | every check, package and verify **succeeded**; `mallory`'s approval refused, `randy` approved; publish **refused before executing** (no `NPM_TOKEN`) — 0 attempts, nothing published | approval boundary, digest-verified hand-off (`package.tar` sha256:517a5f35…), consequential step never runs without credentials |

## Platform defects found by these real runs (fixed)

1. Parallel Rust jobs corrupted a shared cargo registry cache (cargo's lock lived outside the shared path) → cache is all of `CARGO_HOME`; catalog 1.0.1.
2. Job `/tmp` was `noexec` (Docker tmpfs default) → 15 of pax's tests failed for Boundry-only reasons → `/tmp` allows exec.
3. Jobs did not own their workspace → npm workspaces failed with EPERM → workspace handed to the job uid (`chown`, or `podman unshare chown` when rootless).
4. A missing secret was discovered after the lease transaction (stranded lease) → secrets resolved before leasing; job fails cleanly.

## Not done / unsupported

- No human usability review has happened. A walkthrough by the author is not a substitute; it remains an open acceptance item.
- Unavailable: browser tests, deploy, deployment verification, GitHub releases, notifications, Zig, Yarn. Partial (never exercised): Go, Python, Bun, pnpm, npm publishing.
- Multi-toolchain jobs (e.g. Rust tests that also need Node).
- Version allocation, release commits, tags and registry verification: **not here** — they belong to the Maintenance Release Manager.
