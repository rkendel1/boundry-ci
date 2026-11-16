# Boundry CI

Boundry-owned CI/CD control plane. FeltDB is the authoritative state store, GitHub is a replaceable source adapter, workers execute jobs in isolated containers and own no state, and no LLM is involved anywhere.

**Status:** Milestone 1 (vertical slice) works locally against a real FeltDB server, real GitHub reads and real container execution. It is **not deployed** and **not production-ready**: see [`docs/milestones/M1-vertical-slice.md`](docs/milestones/M1-vertical-slice.md).

| Document | Contents |
|---|---|
| [`docs/discovery/FINDINGS.md`](docs/discovery/FINDINGS.md) | What was inspected, measured Actions usage, infrastructure facts, contradictions, risks |
| [`docs/migration-register.md`](docs/migration-register.md) | Every GitHub Actions job (257) with capability, secrets, destinations, duration, status |
| [`docs/architecture.md`](docs/architecture.md) | Authority model, FeltDB collections, job state machine, trust model |
| [`docs/deploy/hetzner-plan.md`](docs/deploy/hetzner-plan.md) | Shared-host deployment, backup, rollback |
| [`schema/ci.v1.schema.json`](schema/ci.v1.schema.json) | The `.boundry/ci.yaml` contract |

## Use

Requires Node ≥ 22.18 (runs TypeScript directly; no build step).

```bash
npm ci
node bin/boundry-ci.ts compile .boundry/ci.yaml kind=push ref=refs/heads/main
FELTDB_SERVER_BIN=/path/to/feltdb-server npm test
```

Configuration is `BCI_*` environment variables (see `bin/boundry-ci.ts`); secrets are read only from 0600 files.
