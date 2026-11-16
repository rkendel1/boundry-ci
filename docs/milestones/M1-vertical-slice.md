# Milestone 1 — vertical slice

GitHub event → FeltDB-backed pipeline → scheduler → isolated worker → durable logs and artifacts → GitHub status.

## Implemented

- `.boundry/ci.yaml` v1: JSON Schema + deterministic compiler (push / pull_request / tag / release / schedule / manual / upstream triggers, DAG, matrix, templates, capabilities, images, timeouts, retries, concurrency groups, scoped secrets, permissions, approvals, caches, artifacts, downstream triggers). Each run records `sourceDigest` (exact bytes) and `planDigest`.
- Control plane over a real FeltDB: exactly-once intake, DAG advancement, atomic leasing, heartbeats, idempotent results, reaper (lost workers and timeouts), retries with per-attempt evidence, cancellation, approvals, concurrency-group supersession, cron schedules with crash-safe slots, downstream triggers, durable status outbox.
- Worker agent with an OCI executor: non-root uid, all capabilities dropped, no-new-privileges, read-only rootfs, pids/memory/CPU limits, `--network none` unless declared, polled workspace disk quota, wall-clock timeout, cancellation, secret masking, trust-scoped cache volumes, artifact upload by digest.
- Content-addressed immutable artifact store with free-space reserve.
- GitHub adapter: HMAC webhook verification, event normalization with fork detection, App-installation tokens (separate read-only checkout token), file reads, branch heads, statuses.
- CLI (`control`, `worker`, `compile`, `admin create-worker`), control-plane image, Hetzner deployment files, workflow inventory and register generators.

## Tested — results

`npm test` (27 tests, real `feltdb-server` built from `rkendel1/flow_db`): **27 pass, 0 fail**.
`node --test test/e2e.test.ts` (real git checkout from github.com, real Docker): **1 pass**.

| # | Required platform acceptance test | Result | Where |
|---|---|---|---|
| 1 | Duplicate webhook delivery | pass (3 concurrent signed deliveries → 1 run; bad signature 401) | platform 01 |
| 2 | Concurrent job claiming | pass (8 workers, 1 lease, 1 attempt) | platform 02 |
| 3 | Worker disappearance | pass | platform 03+04 |
| 4 | Lease expiration | pass (requeue with budget; terminal failure without) | 03+04, 04b |
| 5 | Job retry | pass (attempt 1 evidence preserved) | 05 |
| 6 | Control-plane restart | pass | 06 |
| 7 | FeltDB restart and recovery | pass (explicit `StoreUnavailable`, state intact after restart) | 07 |
| 8 | Duplicate result submission | pass (idempotent; conflicting result rejected; foreign worker rejected) | 08 |
| 9 | Pipeline cancellation | pass | 09 |
| 10 | Dependency failure propagation | pass | 10 |
| 11 | Concurrent commits to one repository | pass (older run superseded) | 11 |
| 12 | Unauthorized release attempts | pass (untrusted PR, wrong capability, wrong approver) | 12 |
| 13 | Secret access from untrusted jobs | pass (rejected at intake; provider never called) | 13 |
| 14 | Artifact digest mismatch | pass | 14 |
| 15 | Cache poisoning attempts | pass for key isolation (trusted/untrusted/repo-scoped; release mounts none). Not tested: a hostile job writing to its own cache. | 15 |
| 16 | Deployment rollback | **not implemented** | — |
| 17 | Deployment health verification | **not implemented** | — |
| 18 | Resource exhaustion | pass (64 MiB job OOM-killed → failed) | e2e |
| 19 | Disk exhaustion | pass (workspace quota kill; CAS free-space reserve 507) | e2e, 19 |
| 20 | Scheduled job recovery | pass (3 missed slots → exactly 1 catch-up run, concurrent ticks) | 20 |

## Live run (real processes, real GitHub reads)

`tools/local-slice.sh rkendel1/boundry-ci f7cc5cd598550f5090d8e3cee5f3cec7265b8804 claude/upbeat-heisenberg-j0e1gj`:
the control plane read `.boundry/ci.yaml` through the GitHub API at that commit; the worker cloned the commit from github.com; `static` and `unit` ran in hardened containers (`npm ci`, compiler tests 7/7) and the package was stored as `sha256:3abe44eed64bafa918a35ae44d6ef900294bfc3575750b9178e7c02cb9546b22` (65,467 bytes). Run `run_3ecb9555fb129d25c70c47a3`: **succeeded**.
The first live run (`96b6d34`) correctly **failed** on a real defect in the pipeline itself (`sh -n` on bash scripts) and skipped the dependent job.

Status delivery to GitHub: **not demonstrated.** This session's GitHub proxy refuses status writes (HTTP 403). The outbox recorded each undelivered status with its error and kept retrying, as designed. Needs the GitHub App.

## Remaining gaps

Platform:
- Not deployed to Hetzner (host unreachable from this session). Rootless Podman path written but not executed; executor verified with rootful Docker only, locally.
- Release/deployment pipelines (AppBoundry integration, publish verification, rollback, health checks), artifact retention/GC driver, CAS backup, CI FeltDB in `backup-boundry.sh`.
- Log streaming is near-real-time chunking, not live tail. No metrics endpoint yet (queue wait, utilization, cache hit rate are derivable from FeltDB timestamps but not reported).
- Disk quota is polled (5 s), not a hard filesystem quota; a job can briefly exceed it.
- macOS worker: agent is portable; executor has no macOS sandbox.
- Cross-repository reusable pipeline definitions (only in-file `templates`).
- Concurrency groups cancel older runs; queue-without-cancel semantics not implemented.

Application-specific (per repo): translation of 257 jobs (`docs/migration-register.md`), `stack-ui` release workflow YAML fix, macOS/Windows decisions, `feltgit` exclusion.

## Deployment and rollback evidence

None yet — nothing was deployed. Plan: `docs/deploy/hetzner-plan.md`.
