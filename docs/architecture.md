# Boundry CI architecture

## Topology (smallest that works)

One control-plane process, one dedicated FeltDB instance, N workers. Logical components map to code:

| Logical component | Code | Owns |
|---|---|---|
| boundry-ci-control | `src/control/core.ts`, `src/control/http.ts` | intake, compilation, DAG scheduling, leases, recovery, operator API |
| boundry-ci-worker | `src/worker/agent.ts` | registration, leasing, heartbeats, checkout, log/artifact upload |
| boundry-ci-executor | `src/worker/executor.ts` | container lifecycle, limits, network, timeout, disk quota, cleanup |
| artifacts & caches | `src/artifacts/cas.ts`, executor cache volumes | immutable content-addressed bytes; disposable, trust-scoped caches |
| source adapter | `src/scm/types.ts`, `src/scm/github.ts` | webhook verification, normalization, file reads, statuses |
| pipeline contract | `schema/ci.v1.schema.json`, `src/spec/compile.ts` | `.boundry/ci.yaml` v1, deterministic compilation |

No LLM anywhere. The scheduler, compiler and recovery are deterministic functions of FeltDB state.

## Authority

- **FeltDB is the only authority** for events, definitions, runs, jobs, attempts, workers, leases, log chunks, artifact metadata, approvals and the status outbox. The control plane holds no state between calls; any number of control-plane restarts are safe (acceptance test 06).
- **Workers own nothing.** A worker's lease is valid only while FeltDB says so. Results for a lease that expired are recorded on the attempt as `late_*` evidence and never change the job.
- **GitHub is an adapter** (`ScmAdapter`). Replacing it means implementing four methods; the scheduler and executor do not change.
- **Secrets** live on the host in 0600 per-repository files and are resolved only at lease time, only for trusted runs, only for names the pipeline declares and the repository is scoped to. They are never written to FeltDB and are masked in logs.
- **Capabilities are granted, not claimed.** A worker advertises capabilities; the effective set is the intersection with what the operator granted when creating the worker identity.

## Collections (FeltDB, namespace `boundry-ci`)

| Collection | Id | Notes |
|---|---|---|
| `ci_events` | `ev_<sha256(provider:delivery)>` | `requireAbsent` ⇒ duplicate deliveries are suppressed |
| `ci_pipeline_defs` | `def_<sha256(source)>` | exact source bytes retained by digest |
| `ci_runs` | `run_<hash(event)>` | `sourceDigest`, `planDigest`, trust, concurrency group |
| `ci_jobs` | `<run>-<hash(key)>` | state machine below; full compiled job spec |
| `ci_attempts` | `<job>-a<n>` | one per lease; never overwritten once terminal |
| `ci_log_chunks` | `<attempt>-<seq>` | ≤256 KiB, idempotent per sequence |
| `ci_artifacts` / `ci_artifact_refs` | `sha256-<hex>` / `<attempt>-<hash(name)>` | bytes on disk; refs carry commit, image, retention |
| `ci_workers` | operator-chosen id | token hash, granted and effective capabilities |
| `ci_approvals` | `<job>-<hash(approver)>` | approver and plan digest at approval |
| `ci_outbox` | `ob_<hash>` | commit statuses; delivered at least once, newest-final wins |
| `ci_schedules` | `sched_<hash(repo,cron,branch)>` | `nextFireAt`; slot-derived event ids |

## Job state machine

```
waiting ──deps succeeded──▶ queued ──lease (CAS)──▶ leased ──start──▶ running ──▶ succeeded | failed | cancelled
   │  └──approval required──▶ awaiting_approval ──approve──▶ queued
   └──a dependency failed/cancelled/skipped──▶ skipped
leased|running ──lease expired / timeout──▶ queued (retry budget left) | failed | cancelled (if cancel requested)
```

Every transition is a FeltDB transaction fenced on the record's `__version`. A lease writes the job and creates the attempt in one transaction; two workers can never hold the same job (acceptance test 02).

## Trust model

`trusted` is decided by the source adapter: pushes, tags and releases are trusted; pull requests are trusted only when the head repository equals the base repository. Untrusted runs: no secrets (rejected at intake), no release/deploy jobs (rejected at intake and again at lease), approvals refused, caches in a separate `u` namespace. Release/deploy jobs must pin images by digest, require the `release`/`deploy` capability and explicit `permissions`, and never mount caches.

## Release and deployment (designed, not yet implemented)

Release = a job with `permissions.release`, `approval.required`, pinned image, inputs only from verified artifacts (by digest), scoped publish credentials from the secret provider, then a separate verification job that re-downloads and re-hashes the published output. Deployment of AppBoundry-hosted apps goes through AppBoundry's existing API (`POST /api/applications/{id}/artifacts`, `.../deployments` with an `Idempotency-Key`), and health is verified independently of AppBoundry's own report. Boundry CI does not add a second deployment control plane.
