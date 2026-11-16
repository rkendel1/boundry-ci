# Boundry CI operator runbook (shared Hetzner host)

Everything here is executed by an operator. Steps marked **APPROVAL** change the host and must be
explicitly authorized first. Nothing in this runbook modifies or restarts an existing Boundry service,
the platform compose project, `/etc/caddy` (until step 9), the firewall, or the Docker daemon.

Layout: `/opt/boundry-ci/{releases/<id>,active,current,bin}`, `/etc/boundry-ci/{secrets,repo-secrets,deployer,worker}`,
`/var/lib/boundry-ci/{feltdb,data,work,deployments.jsonl}`, `/var/backups/boundry-ci`.
Identities: uid 21030 (control), uid 21031 (CI FeltDB), account `bci-worker` (worker + rootless Podman).

## 0. Read-only checks (no approval needed)

```bash
appboundry/deploy/boundry/host-preflight.sh root@95.217.199.123 host-preflight.json
```

```bash
ssh root@95.217.199.123 'bash -s' < deploy/hetzner/ci-preflight.sh
```

Record both outputs in `docs/deploy/readiness-report.md`. Size `boundry-ci.slice` from them.
**Stop** if: CPU/memory pressure is already present, ports 21030/21031 or 172.31.8.0/24 are in use, or `/var/lib` has less than 40 GiB free.

## 1. Host preparation — APPROVAL

```bash
apt-get install -y podman uidmap passt fuse-overlayfs
```

```bash
useradd --system --create-home --home-dir /home/bci-worker --shell /usr/sbin/nologin bci-worker && usermod --add-subuids 300000-365535 --add-subgids 300000-365535 bci-worker && loginctl enable-linger bci-worker
```

Verify rootless Podman works for that account *before* going further (this is the evidence that it is viable):

```bash
sudo -u bci-worker XDG_RUNTIME_DIR=/run/user/$(id -u bci-worker) podman run --rm --network none --user 65534:65534 --read-only --cap-drop ALL docker.io/library/alpine@sha256:<pinned> id
```

Install the units (new files only; `daemon-reload` does not restart anything else):

```bash
install -m 0644 deploy/hetzner/boundry-ci.slice deploy/hetzner/boundry-ci-worker.service deploy/hetzner/boundry-ci-backup.service deploy/hetzner/boundry-ci-backup.timer /etc/systemd/system/ && systemctl daemon-reload
```

```bash
install -d -m 0755 /opt/boundry-ci/bin && install -m 0750 deploy/hetzner/bci-deploy /opt/boundry-ci/bin/bci-deploy
```

## 2. Build and ship a release (workstation, never on the host)

```bash
BCI_IDENTITY_SCRIPT=../appboundry/deploy/boundry/image-identity.mjs deploy/hetzner/make-release.sh ./releases <platform-feltdb-image-tag> <canary-image>@sha256:<digest> settings.json
```

`settings.json` must set `githubAppId`, `githubInstallations` (`rkendel1=<installation id>`), `publicHost`. It must not set `allowRootfulExecutor`.

```bash
appboundry/deploy/boundry/ship-images.sh root@95.217.199.123 boundry-ci:<commit> <canary-image>@sha256:<digest>
```

```bash
scp -r ./releases/<release-id> root@95.217.199.123:/root/boundry-ci-releases/
```

## 3. Secrets (operator-supplied, never committed, never in an image)

```bash
/opt/boundry-ci/bin/bci-deploy --image boundry-ci:<commit> init /root/boundry-ci-releases/<release-id>
```

`init` generates (never overwrites, never prints): CI FeltDB master/session/grant keys, the control plane's FeltDB key (`state:read,state:write`), the backup key (`cluster:write`), the deployer's operator token. It reports `MISSING` for what only the owner can supply; install those with:

```bash
install -m 0440 -o root -g 21030 github-app.pem /etc/boundry-ci/secrets/control/github-app.pem
```

```bash
install -m 0440 -o root -g 21030 webhook-secret /etc/boundry-ci/secrets/control/github-webhook
```

Per-repository build secrets (only if a pipeline declares them): `/etc/boundry-ci/repo-secrets/<owner>__<repo>.env`, mode 0440, group 21030.

## 4. Install / upgrade (transactional)

```bash
BCI_DEPLOY_WORKER_UID=$(id -u bci-worker) /opt/boundry-ci/bin/bci-deploy --image boundry-ci:<commit> preflight /root/boundry-ci-releases/<release-id>
```

```bash
BCI_DEPLOY_WORKER_UID=$(id -u bci-worker) /opt/boundry-ci/bin/bci-deploy --image boundry-ci:<commit> apply /root/boundry-ci-releases/<release-id>
```

`apply` exits 0 only when the release is **committed**: pinned images are what run, FeltDB is ready with auth and writable storage, the control plane serves the release's revision, a FeltDB write/read/delete and an artifact write/read/hash succeed, the worker reports the release's revision, and a canary job is leased, executed in isolation, and stores an artifact. Any failure rolls back automatically to the previous committed release (`rolled_back`), or, on a first install, removes what it started (`aborted_first_install`; data kept). Re-running the same release is a verified no-op.

## 5. Diagnose (read-only)

```bash
/opt/boundry-ci/bin/bci-deploy status
```

Shows current/active release, the last 12 journal events (hash chain verified), service state, workers (revision, last seen), active jobs by state, and the status outbox (pending, failing, last errors). It never prints secrets.

```bash
/opt/boundry-ci/bin/bci-deploy verify
```

Re-runs all health checks including a canary (writes a canary run; not read-only). `verify --no-canary` skips the canary.

## 6. Rollback

```bash
/opt/boundry-ci/bin/bci-deploy rollback
```

Re-activates the previous committed release (image **and** configuration) and verifies it before committing.

## 7. Backup and restore

```bash
systemctl enable --now boundry-ci-backup.timer
```

```bash
/opt/boundry-ci/bin/bci-deploy restore /var/backups/boundry-ci/<YYYYMMDDTHHMMSSZ>
```

Restore stops the worker and CI services, verifies checksums and the bundle, restores with `feltdb-server backup restore`, moves current data aside (never deletes), restores missing artifacts, restarts and runs full verification.

## 8. Remove Boundry CI completely (no effect on other services)

```bash
systemctl disable --now boundry-ci-worker boundry-ci-backup.timer && docker compose -p boundry-ci -f /opt/boundry-ci/active/compose.yml --env-file /opt/boundry-ci/active/release.env down
```

Data stays in `/var/lib/boundry-ci` and `/var/backups/boundry-ci` until deliberately deleted.

## 9. Ingress — APPROVAL (only after the GitHub App exists)

Copy `deploy/hetzner/boundry-ci.caddy` to `/etc/caddy/boundry-ci.caddy` with the real host name, add `import /etc/caddy/boundry-ci.caddy` to the Caddyfile, then:

```bash
caddy validate --config /etc/caddy/Caddyfile && systemctl reload caddy
```

Re-run `host-preflight.sh` and compare with the step-0 baseline: no existing container restarted, no other change.

## Host activation checklist

| # | Step | Approval | Evidence to record |
|---|---|---|---|
| 1 | Run both preflights (§0) | no | JSON + text output |
| 2 | Size `boundry-ci.slice` from evidence | no | chosen values + reasoning |
| 3 | Install Podman, create `bci-worker`, linger (§1) | **yes** | package versions |
| 4 | Rootless Podman smoke run as `bci-worker` (§1) | no | output of `id` in container |
| 5 | Install units + `bci-deploy` (§1) | **yes** | `systemctl cat` |
| 6 | Create GitHub App (`docs/github-app.md`) | **owner** | app id, installation id |
| 7 | Build/ship release (§2) | no | release.json |
| 8 | `init` + supply App key and webhook secret (§3) | no | init report (names only) |
| 9 | `preflight` then `apply` (§4) | **yes** | apply output: `committed` + 6 checks |
| 10 | `backup` + `restore` drill on the host (§7) | **yes** | journal entries |
| 11 | Neighbour comparison (host-preflight again) | no | diff = only boundry-ci additions |
| 12 | Caddy route + webhook delivery test (§9) | **yes** | GitHub "Recent deliveries" 2xx, run created |
| 13 | Status delivered to a test repository | no | commit status visible on GitHub |
