# Milestone 2 — deployment readiness and safe activation

Scope: prove Boundry CI can be installed, verified, upgraded, rolled back, backed up and restored safely.
No workflow migration. **No Hetzner deployment happened**: the host is unreachable from this environment.

## Implemented

- `boundry-ci deploy init | preflight | apply | rollback | verify | status | backup | restore` (`src/deploy/`), wrapped by `deploy/hetzner/bci-deploy`, which runs the tool from the pinned image's own runtime (no host Node dependency).
- Transactional lifecycle: immutable release directories (manifest, compose, rendered non-secret config, worker runtime extracted from the pinned image); `active`/`current` pointers flipped atomically; hash-chained, fsynced journal; deploy lock; automatic rollback; a committed release is never torn down automatically.
- Independent health verification: pinned image IDs are what run; FeltDB `/ready` reports ready + authenticated + writable; the control plane serves the release revision; FeltDB write/read/delete and every CI collection queryable; artifact store write/read/hash; worker registered with the release revision; a canary job leased, executed in the real executor, artifact stored, by this release's worker.
- Preflight refusals: digest mismatch, rootful executor without explicit opt-in, missing secrets or broader-than-allowed modes, occupied ports, subnet overlap with any Docker network, release/deploy capability on the shared-host worker.
- Least-privilege FeltDB keys; backup/restore through FeltDB's own backup commands; restore-safe version-token fencing.
- Operator assets: parameterized compose, worker systemd unit (rootless Podman, CI slice), backup service/timer, release builder, CI preflight, runbook, readiness report, GitHub App report.

## Defects found and fixed in this slice (by the new tests, not by inspection)

1. **Re-uploading identical artifact bytes failed** (HTTP 500, FeltDB `IDEMPOTENCY_CONFLICT`): every reproducible rebuild would have failed. Found by the deployment canary. Regression test added.
2. **A restored CI database would refuse every lease and state transition**: FeltDB starts a new history on restore and rejects numeric fences. All 17 fences now use `fv1` version tokens. Proven by D9.
3. **Re-applying the current release after a failed re-verification tore the installation down** (first-install branch). Fixed; a committed release is never removed automatically.
4. Control-plane FeltDB key was `*`; now `state:read,state:write`. Repeated `--scope` flags silently keep only the last (FeltDB CLI behaviour); documented and avoided.
5. Deploy errors dropped the failing command's stderr; errors now carry the last stderr line (no env, no secrets).

## Tested — results, and what was real

| Suite | Result | Real | Simulated / substituted |
|---|---|---|---|
| `npm test` (compiler, platform, GitHub) | **33 pass** | feltdb-server built from flow_db; HTTP servers; FeltDB restarts | GitHub API stand-in for G1–G4 |
| `npm run test:e2e` | **1 pass** | git checkout from github.com; Docker executor; OOM and disk-quota kills | GitHub file/status calls use an in-memory adapter |
| `npm run test:deploy` (D0–D9) | **11 pass** (≈310 s) | Docker Compose project; FeltDB in production mode (auth, 3 secrets, uid 21031, read-only rootfs); control images built from this repo; worker process; canary jobs; online backup + `backup restore` | FeltDB image is a test stand-in (same entrypoint/user model as `flow_db/deploy/Dockerfile`, Ubuntu base because the local binary needs glibc 2.39); worker driver is `process`, not systemd; executor is rootful Docker with explicit opt-in, not rootless Podman; host is this container, not Hetzner |
| Operator path (`make-release.sh` → `bci-deploy --image … init / apply / status / backup / rollback / verify`) | **all as documented** | same as deploy suite | same |

Deployment acceptance criteria → evidence:

| Requirement | Test |
|---|---|
| 1 Install failure leaves the previous version intact | D4 (container never serves → `rolled_back`, previous revision serving) |
| 2 Control-plane health independently verified | D1 (revision served, probe), D4 |
| 3 Worker health independently verified | D1 (revision + heartbeat + canary), D5 |
| 4 FeltDB connectivity and state access | D1 (ready/auth/storage, write/read/delete, all collections), D9 (key scopes) |
| 5 Artifact storage writable, readable, hash-verified | D1 probe + canary artifact; D6 (unwritable → rollback) |
| 6 Failed health check prevents success | D5, D6 (all containers healthy, still `rolled_back`) |
| 7 Rollback restores previous version and configuration | D6 (config), D7 (manual rollback, image + config) |
| 8 Restart/recovery preserves queued jobs, leases, attempts, outbox | D3 (upgrade across restarts; lease honoured by new control plane), D9 (restore) |
| Idempotent rerun / concurrent deploys / integrity | D2, D8 |
| Refusals before any change | D0, D0b |

## Remaining gaps

Platform:
- **Not deployed.** No host observation, no rootless Podman validation, no systemd driver run, no real Caddy route.
- **No status delivered to real GitHub** (App not created; this environment's proxy refuses status writes).
- Off-host backup copy and inclusion in the platform restore drill.
- Worker graceful drain is bounded by `TimeoutStopSec` (600 s); longer jobs are cut and retried/failed by lease expiry.
- Rootless Podman egress networking (`--network bridge` rootless) unvalidated.

Application-specific: none in this slice (no workflow migrated by design).

## Deployment and rollback evidence

All deployment and rollback evidence is from local runs (journal entries asserted by D0–D9). There is no Hetzner evidence.
