# Host capacity and deployment-readiness report

Date: 2026-11-16. **The Hetzner host (95.217.199.123) was not inspected**: TCP 22 is refused from the
environment this work ran in, and no host credentials exist there. Nothing below is an observation of
the live host. Each item says where its evidence comes from.

## 1. What must be observed on the host (not yet done)

Run both, read-only, and attach the output to this report before activation:

```bash
appboundry/deploy/boundry/host-preflight.sh root@95.217.199.123 host-preflight.json
```

```bash
ssh root@95.217.199.123 'bash -s' < deploy/hetzner/ci-preflight.sh
```

| Question | Answered by | Status |
|---|---|---|
| CPU threads, memory available, PSI pressure, load | host-preflight (`facts.resources`) | **unknown** |
| Disk free on `/`, Docker root, `/var/lib`, `/var/backups` | host-preflight + ci-preflight | **unknown** |
| Running containers and their limits | host-preflight neighbour snapshot | **unknown** |
| Caddy version, site blocks, imports | host-preflight (`facts.caddy`) | **unknown** |
| Firewall and listening ports | host-preflight (`ufw status`, `ss -l`) | **unknown** |
| Ports 21030/21031 and subnet 172.31.8.0/24 free | ci-preflight; `deploy preflight` re-checks against every Docker network | **unknown** |
| Rootless Podman viable for `bci-worker` | ci-preflight (podman ≥ 4.4, uidmap, passt/slirp4netns, fuse-overlayfs, subuid, linger, userns) | **unknown — and likely absent** (repository docs describe rootful Docker only) |
| `/opt/boundry/image-identity.mjs` present | ci-preflight | **unknown** (installed by `install-boundry.sh` if that ran) |

## 2. What is known from repository evidence

Source: `rkendel1/appboundry/deploy/boundry/` (SERVER-PLAN.md, STAGE2.md, SHARED-HOST.md, compose.yml).

- Rootful Docker 29.x, cgroup v2, compose v2. Loopback ports in use by the platform: 21001-21003, 21010, 21011, 21020. AppBoundry apps use 20401 and 20500-20999.
- Protected neighbours: vote.app, Clearline, Mailport, a privileged kind cluster, `/var/lib/appboundry`, existing containers/networks/volumes, `/etc/caddy`, firewall, Docker daemon config. Boundry CI touches none of them (separate compose project, own network, own directories, own units).
- The platform preflight's own minimums (`host-preflight.mjs`): 8 GiB memory available, 8 CPU threads, 60 GiB disk free.

## 3. What Boundry CI needs (measured or configured, not estimated)

| Component | Limit (enforced) | Evidence |
|---|---|---|
| CI FeltDB | 1 CPU, 768 MiB, 256 pids | `deploy/hetzner/compose.yml`; ran under these limits in the deployment tests |
| Control plane | 1 CPU, 512 MiB, 128 pids | same |
| Worker + all job containers | `boundry-ci.slice` ceiling (default 4 CPU, 12 GiB, 4096 tasks) — **must be resized from the preflight report** | `deploy/hetzner/boundry-ci.slice` |
| Per job | `resources` in `.boundry/ci.yaml` (default 2 CPU, 2 GiB, 4 GiB workspace, 1024 pids) | e2e test: a 64 MiB job was OOM-killed; a 64 MiB workspace quota killed a 400 MiB write |
| Artifact store | refuses writes below `casMinFreeBytes` (production default 20 GiB) | platform test 19; deployment test D6 |

Demand (measured, `docs/discovery/actions-usage-30d.json`): private repositories used 20,880 Linux job-minutes in 30 days (≈0.5 concurrent 2-core jobs on average), with peaks of 24 concurrent jobs. With the initial 4-CPU slice (two concurrent 2-CPU jobs) average demand fits; peaks will queue. Queue wait must be measured after the first repositories move, not assumed.

**Decision rule:** if the host report shows less than (2 × 2 CPU, 2 × 4 GiB) free after production headroom, the existing host cannot absorb build peaks without harming production, and that is the evidence for or against additional capacity. No server is proposed now.

## 4. FeltDB isolation — verified against implementation and workload

- Implementation: `crates/feltdb/src/lib.rs:673` — `inner: Arc<Mutex<Inner>>`; `crates/feltdb-server/src/main.rs` (~9541): "the database serializes every read and write on one lock"; at most 64 requests in flight, 10 s request deadline (overload is shed).
- Workload (`tools/bench/feltdb-contention.ts`, local feltdb-server, 10 s each, small read every 20 ms while N writers append 64 KiB log chunks):

| CI writers | Writes/s | Read p50 | Read p99 | Read max |
|---|---|---|---|---|
| 0 | — | 1.2 ms | 3.4 ms | 14.5 ms |
| 4 | 602 | 3.5 ms | 10.7 ms | 2,193 ms |
| 16 | 740 | 19.5 ms | 37.5 ms | 3,691 ms |

This is a deliberately heavy write load (real CI logs arrive more slowly), but multi-second stalls already appear with 4 writers. **Conclusion: CI gets its own feltdb-server instance** (same image, same backup tooling), never the production `feltdb-control`/`feltdb-managed`.

## 5. FeltDB facts that shaped the deployment (verified against flow_db @ a55a5a6)

- Production mode requires `FELTDB_SESSION_SECRET`, `FELTDB_GRANT_SIGNING_KEY` and `FELTDB_MASTER_KEY`, each ≥ 32 bytes and non-development, plus auth enabled (`validate_production_configuration`). `deploy init` generates them; they are never printed.
- Least-privilege keys: control plane `state:read,state:write`; backups `cluster:write`. Each is refused (403) on the other's routes (deployment test D9). **Footgun:** `keys create` keeps only the *last* of repeated `--scope` flags; scopes must be one comma-separated value.
- **Restore changes fencing.** `backup restore` starts a new database history; numeric `expectedVersion` fences are then refused with `predicate: "history"`. Boundry CI now fences on `fv1:<FeltDB-History>:<version>` tokens everywhere; deployment test D9 restores a real backup and keeps operating. Before this change, a restored CI database would have refused every lease and state transition.

## 6. Rootless execution

The worker refuses to drive a rootful Docker daemon unless the release explicitly sets `allowRootfulExecutor: true` (preflight, test D0b). The production release template (`make-release.sh`) sets `ociCli: podman`. **Rootless Podman on this host has not been validated anywhere**: the executor's flags were exercised with Docker only. The worker unit and prerequisites are written; installing them needs approval (see runbook §1). Container isolation is one boundary; untrusted (fork) runs additionally never receive secrets, release/deploy capability, or trusted caches.

## 7. Backup and recovery constraints

- `deploy backup`: FeltDB online backup via `POST /admin/backups` (cluster:write key) + content-addressed artifact pool + release definition + journal, with `SHA256SUMS`, newest 48 sets kept. Tested (D9).
- `deploy restore <set>`: verifies checksums, verifies the bundle with `feltdb-server backup verify`, restores with `feltdb-server backup restore` (the only supported restore path), moves current data aside (never deletes), brings back missing artifact objects, restarts, and runs full verification. Tested (D9), including refusal of a tampered set without stopping service.
- Not done: off-host copy (`pull-backup.sh` pattern) and inclusion in the platform restore drill.
