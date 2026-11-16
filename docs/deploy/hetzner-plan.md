# Deployment plan — shared Hetzner host (not yet executed)

Nothing in this plan has been run on the host. This session cannot reach it (SSH refused). Every step is
operator-executed and separately authorized, following `appboundry/deploy/boundry` conventions.

## 0. Preconditions (read-only)

1. `appboundry/deploy/boundry/host-preflight.sh root@95.217.199.123` — existing read-only capacity/health report (CPU, memory, PSI, disk, cgroups, Docker, Caddy). Keep the JSON.
2. `ssh root@95.217.199.123 'bash -s' < deploy/hetzner/ci-preflight.sh` — CI addendum: rootless Podman prerequisites, ports 21030/21031, subnet 172.31.8.0/24, free space.
3. Decision gate: size `boundry-ci.slice` (CPU/memory ceiling) from (1) as *capacity minus production headroom*. If the slice that remains cannot fit two concurrent `linux-build` jobs (2 CPU / 4 GiB each), the existing host is insufficient for build peaks and that is the evidence for (or against) additional capacity.

## 1. Services

| Unit | Kind | Port | Limits | Health | Restart |
|---|---|---|---|---|---|
| `boundry-ci-feltdb` | compose (`deploy/hetzner/compose.yml`) | 127.0.0.1:21031 | 1 CPU, 768 MiB, 256 pids | `GET /ready` | unless-stopped |
| `boundry-ci-control` | compose | 127.0.0.1:21030 | 1 CPU, 512 MiB, 128 pids | `GET /readyz` (checks FeltDB) | unless-stopped |
| `boundry-ci-worker` | systemd (`boundry-ci-worker.service`) in `boundry-ci.slice` | none (outbound to 21030) | slice ceiling + per-job limits | worker heartbeats in FeltDB | always |

Network: separate compose project and bridge `boundry-ci` (172.31.8.0/24); no attachment to the platform `boundry` network. Only loopback ports are published.

Volumes: `/var/lib/boundry-ci/feltdb` (CI state), `/var/lib/boundry-ci/data/cas` (artifacts), `/var/lib/bci-worker/work` (ephemeral workspaces), Podman storage under `bci-worker`'s home. Config/secrets: `/etc/boundry-ci/secrets/**` (0600, root-owned; mounted read-only).

Ingress: `deploy/hetzner/boundry-ci.caddy` exposes only `/webhooks/github`, `/v1/*` (all token-authenticated) and `/healthz`. Applying it is a separate authorized Caddy change (import line, validate, graceful reload).

Firewall: no change. Only 443 via Caddy is used; workers on the host use loopback; off-host workers (Mac) connect outbound to the Caddy host name.

## 2. Install (operator)

1. Create accounts/uids: 21030 (control), 21031 (CI FeltDB), `bci-worker` with a subuid/subgid range; install `podman uidmap passt fuse-overlayfs` (host change — approve explicitly).
2. Build images off-host: `docker build -f deploy/Dockerfile -t boundry-ci:<git-sha> .`; reuse the platform's immutable FeltDB image tag. Ship with `appboundry/deploy/boundry/ship-images.sh --lock …` (refuses mutable tags).
3. Secrets: FeltDB master key/session secret for the CI instance; an API key created with `feltdb-server keys create … --namespace boundry-ci`; GitHub App private key and webhook secret; operator token hashes; per-repo secret files.
4. `docker compose -p boundry-ci -f /opt/boundry-ci/compose.yml up -d`; wait for both health checks.
5. `boundry-ci admin create-worker hetzner-1 linux-small linux-build` → token file; enable `boundry-ci.slice` and `boundry-ci-worker.service`.
6. Neighbour check: re-run `host-preflight.sh` and compare with the baseline (no existing container restarted, no Caddy/network/volume change besides the authorized ones).

## 3. Backup and recovery

- CI FeltDB: add the instance to `backup-boundry.sh` (it already drives `POST /admin/backups` for the platform instances) and to the restore drill. **Gap:** requires a change in `appboundry/deploy/boundry`.
- Artifacts: content-addressed, so backup is an append-only `rsync` of `cas/sha256/` (`pull-backup.sh` pattern). Caches are not backed up (disposable by design).
- Recovery: restoring FeltDB + CAS restores all history; the reaper requeues or fails anything that was in flight.

## 4. Rollback

Boundry CI is additive. Rollback = `systemctl disable --now boundry-ci-worker`, `docker compose -p boundry-ci down` (volumes kept), remove the Caddy import line + graceful reload. GitHub Actions stays enabled until Stage 5, so rollback never leaves a repository without CI.

## 5. GitHub App (owner action)

Create a GitHub App "Boundry CI": permissions Contents: read, Commit statuses: read & write, Metadata: read; webhook events push, pull_request, release; webhook URL `https://<ci host>/webhooks/github`. Install it on the repositories being migrated. Checkout tokens are requested with Contents: read only.
