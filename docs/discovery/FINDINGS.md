# Boundry CI — discovery findings (2026-11-16)

Evidence-first. Each claim names its source. "Not verified" means exactly that.

## 1. What could and could not be inspected

| Area | Status | Evidence / blocker |
|---|---|---|
| Hetzner host 95.217.199.123 | **Not inspected** | TCP 22 refused from this session; no host credentials here. All host facts below come from repository documents, not the live host. |
| Repositories | 30 repos with workflows cloned and parsed (6 private, 24 public) | `docs/discovery/workflow-jobs.json` (257 jobs, 122 workflows) |
| Repositories with no workflows | inspected: `feltdb_intent`, `frame`, `ledger`, `multiplayer`, `resolver-control`, `saaskit` | no `.github/workflows` |
| Remaining repositories | **Not inspected** | `list_repos` was truncated (>200 repos). Code search shows ~100 more repos with workflows, nearly all forks of third-party projects (e.g. Cognee2, kongapi, haystack, vscode, appsmith). Owner must confirm none are Boundry-active. Private repos not attached to this session (e.g. `ii8`, `attn`, `brain`, `synapse`, `acord`, `agent`) were not inspected. |
| GitHub billing | **Not accessible** | `users/*/settings/billing/*` is blocked for this session. Usage below is measured from run/job timings instead. |
| Actions usage of public repos | **Not measured** | Actions API for unattached public repos requires write-scoped attachment; not requested. |

## 2. Measured GitHub Actions usage (30 days, private repos)

Source: `docs/discovery/actions-usage-30d.json`, produced by `tools/inventory/usage-analyze.mjs` from every job of every run created 2026-10-17..2026-11-16 in `flow_db`, `feltkit`, `appport`, `appboundry`, `authboundry`, `stack-intel`.

| Measure | Value |
|---|---|
| Jobs executed | 4,221 |
| Linux job minutes (billable, per-job rounded up) | 20,880 |
| macOS job minutes (billable) | 1,162 (all in `authboundry`: `cli-smoke.yml`, `release.yml`) |
| Windows | 0 |
| Linux-equivalent minutes (macOS ×10) | 32,500 |
| Minutes spent on failed/cancelled jobs | 6,782 (≈32%) |
| Peak concurrent jobs | 24 |
| Largest consumers | `flow_db` 10,632 min (ci.yml 7,366; proof-qualification 1,061, max job 360 min); `feltkit` 5,458 min (ci.yml 5,040) |

**Cost implication (needs owner confirmation against the actual invoice):** GitHub-hosted standard runners are free for public repositories, so the bill is driven by these private repositories. At published per-minute rates (Linux 2-core ≈ $0.006–0.008, macOS ≈ $0.062–0.08, depending on which price list applies to the account) the 30-day private usage is roughly **$190–260/month before included minutes**. Migrating *public* repositories saves no GitHub money and consumes Hetzner capacity; the order of migration should follow the money (private repos first) unless removing the GitHub Actions dependency itself is the goal for public repos too. That is an owner decision.

Average demand is ≈0.5 concurrent 2-core jobs (20,880 min / 43,200 min per month), but peaks reach 24. With a handful of worker slots, peaks will queue. Queue-wait is the real cost of moving to one shared host; it must be measured after Stage 2, not assumed.

## 3. Infrastructure (from repository documents, not the live host)

Source: `rkendel1/appboundry/deploy/boundry/*` (SERVER-PLAN.md, compose.yml, boundry.caddy, STAGE2.md, SHARED-HOST.md).

- Runtime: **rootful Docker** (29.x, cgroup v2, compose v2). **No Podman, no rootless runtime documented.** The prompt asks for rootless OCI execution; that requires installing rootless Podman (or rootless Docker) for a dedicated account — a host change needing explicit approval (`deploy/hetzner/ci-preflight.sh` checks the prerequisites read-only).
- Conventions reused: loopback-only ports in 21000–21099 (in use: 21001-21003, 21010, 21011, 21020), `read_only` + `cap_drop: ALL` + `no-new-privileges` containers, dedicated numeric uids, secrets in 0600 files, immutable image tags shipped with `ship-images.sh` ("never compile on the shared server"), Caddy changes via `import` + `caddy validate` + graceful reload.
- Protected on the shared host: vote.app, Clearline, Mailport, a privileged kind cluster, `/var/lib/appboundry`, existing containers/networks/volumes, `/etc/caddy`, firewall, Docker daemon config.
- Backups: `backup-boundry.sh` hourly via FeltDB `POST /admin/backups`, restore drills, `pull-backup.sh` to a workstation. Boundry CI's FeltDB instance must be added to this mechanism (gap).
- **Contradiction with an assumption:** `api.feltdb.com` (managed FeltDB) is documented both as a Fly app (`flow_db/deploy/control-plane/fly.toml`) and as live on the Hetzner host (`FELTDB-BUNDLE-FIX-ROLLOUT.md`). Which is authoritative is not verified.
- **AppBoundry deployments** accept AppBoundry/FeltKit artifacts for its pinned runner image (`POST /api/applications/{id}/deployments` with `{artifactId, hostId}` + `Idempotency-Key`; agent verifies SHA-256 and health). It does not deploy arbitrary container images. So: AppBoundry is the deployment authority for AppBoundry-hosted apps (Boundry CI must call it, not duplicate it); platform services on the shared host are still deployed by an operator over SSH (`install-boundry.sh`). There is no deployment API for those today — a platform gap, not something Boundry CI should invent.

## 4. FeltDB contract actually used

Verified against a locally built `feltdb-server` (rkendel1/flow_db @ a55a5a6) and its source:

- `POST /transactions` — atomic, fsync-acknowledged; `transactionId` bound to a payload digest (same id + same payload ⇒ `duplicate: true`; different payload ⇒ `IDEMPOTENCY_CONFLICT`); per-operation `requireAbsent` / `expectedVersion`; violations ⇒ HTTP 409 `PRECONDITION_FAILED` with a structured `failure`.
- `POST /query` — bounded (`limit` 1..1000, cursor), `where` with eq/neq/lt/lte/gt/gte/in, `orderBy`.
- `GET /collections/{c}/{id}` — record with `__version`.
- Record ids: `[A-Za-z0-9_-]{1,128}` (`validate_segment`, main.rs ~19034).
- **Request bodies are capped at 1 MiB** (HTTP 413 verified). Artifact bytes therefore cannot live in FeltDB; Boundry CI stores them content-addressed on disk with metadata in FeltDB. Log chunks are kept ≤256 KiB per record.
- One lock serializes all reads and writes (main.rs ~9541). CI state therefore goes to a **dedicated** FeltDB instance, not the production ones.
- FeltDB's experimental Durable Work API (`/v1/workloads`, `/v1/workers`) was evaluated and not used: it is marked experimental and "one writer per cluster"; the stable transaction/CAS contract is sufficient for leases.

## 5. Workflow inventory highlights

Full register: `docs/migration-register.md` (generated). Summary of 257 jobs:

| Status | Jobs |
|---|---|
| Ready to translate (Linux) | 153 |
| Release/deploy path (Stage 4) | 37 |
| Needs a macOS worker | 46 (`fx`, `2fx`, `compute`, `authboundry`, `felt-session`, `stack-agent`, `pax`, `personalOS`, `homebrew-compute`) |
| Windows (no worker planned; owner decision) | 2 |
| Fork with inherited upstream workflows (`feltgit`) | 18 — recommend exclude |
| Unparseable | 1 — `stack-ui/.github/workflows/release.yml` line 41: unquoted `: ` inside `run:`. GitHub cannot parse it either, so **stack-ui releases cannot currently run**. |

Destinations that must be preserved: GitHub Releases (17 jobs), Homebrew taps (15), npm (10), App Store/TestFlight (5), Cloudflare (4), GitHub Pages (3), GHCR (2), crates.io (2), Fly.io (1).

Duplicate work: `fx` and `2fx` share 9 identically named workflows (bench, binary-size, cdn-backfill, ci, dev-release, full-ci, pgso-macos-arm64, prepare-release, publish-libfx, release); `compute`/`chip-rs`/`fx` each run their own Rust/Zig toolchain setup — candidates for shared templates (`templates:` / `extends:` in `.boundry/ci.yaml`).

## 6. Risks

1. **Rootless execution not yet available on the host.** Until rootless Podman is installed for `bci-worker`, running jobs means rootful Docker, i.e. root-equivalent access for the worker account. Do not run the worker against rootful Docker on the shared production host.
2. **Shared-host contention.** Peaks of 24 concurrent jobs vs one host also serving production. The `boundry-ci.slice` ceiling is mandatory, and its values must come from the host preflight.
3. **macOS** (46 jobs, and the only macOS spend) cannot run on Hetzner. Needs a Mac worker (the agent runs there unchanged; executor needs a macOS sandbox strategy — gap).
4. **Fork PRs** on public repos are untrusted by construction (`trusted:false`): no secrets, no release/deploy, separate cache namespace. Container isolation remains one boundary only.
5. **GitHub App not yet created.** Status writes need an App with `statuses:write`; this session's proxy blocks status writes (HTTP 403), so live status delivery is unproven.
