# Boundry CI

Boundry-owned CI/CD control plane. FeltDB is the authoritative state store, GitHub is a replaceable source adapter, workers execute jobs in isolated containers and own no state, and no LLM is involved anywhere.

**Status:** Milestone 2 (deployment readiness) — transactional install/upgrade/rollback/backup/restore with independent health verification, proven locally with real Docker Compose, FeltDB and containers. **Not deployed to Hetzner** (host unreachable from the build environment) and **no status yet delivered to real GitHub** (App not created). See [`docs/milestones/M2-deployment-readiness.md`](docs/milestones/M2-deployment-readiness.md) and [`M1`](docs/milestones/M1-vertical-slice.md).

| Document | Contents |
|---|---|
| [`docs/discovery/FINDINGS.md`](docs/discovery/FINDINGS.md) | What was inspected, measured Actions usage, infrastructure facts, contradictions, risks |
| [`docs/migration-register.md`](docs/migration-register.md) | 239 GitHub Actions jobs (257 found; `feltgit` excluded) with capability, secrets, destinations, duration, status, and the owner decisions applied |
| [`docs/architecture.md`](docs/architecture.md) | Authority model, FeltDB collections, job state machine, trust model |
| [`docs/deploy/runbook.md`](docs/deploy/runbook.md) | Operator install/upgrade/rollback/backup/restore + host activation checklist |
| [`docs/deploy/readiness-report.md`](docs/deploy/readiness-report.md) | Host capacity requirements, FeltDB isolation evidence, constraints |
| [`docs/github-app.md`](docs/github-app.md) | GitHub App permissions, verified behaviour, remaining blocker |
| [`schema/ci.v1.schema.json`](schema/ci.v1.schema.json) | The `.boundry/ci.yaml` contract |

## Use

Requires Node ≥ 22.18 (runs TypeScript directly; no build step).

```bash
npm ci
node bin/boundry-ci.ts compile .boundry/ci.yaml kind=push ref=refs/heads/main
FELTDB_SERVER_BIN=/path/to/feltdb-server npm test
```

Slower suites (`test:e2e`, `test:deploy`) are described in [`test/README.md`](test/README.md).

Configuration is `BCI_*` environment variables (see `bin/boundry-ci.ts`); secrets are read only from files that are neither group-writable nor world-accessible (0600, or 0440 owned root:<service group>).
