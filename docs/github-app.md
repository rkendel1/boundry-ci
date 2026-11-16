# GitHub App integration — readiness report

GitHub is a source adapter. Boundry CI never needs GitHub Actions to run anything.

## App definition (owner creates it; Boundry CI cannot)

| Setting | Value |
|---|---|
| Repository permissions | **Contents: Read-only**, **Commit statuses: Read and write**, **Metadata: Read-only** (mandatory). Nothing else. |
| Organization / account permissions | none |
| Webhook events | `push`, `pull_request`, `release` |
| Webhook URL | `https://<ci host>/webhooks/github` (after runbook §9) |
| Webhook secret | random ≥ 32 bytes → `/etc/boundry-ci/secrets/control/github-webhook` (0440 root:21030) |
| Private key | → `/etc/boundry-ci/secrets/control/github-app.pem` (0440 root:21030) |
| Installation scope | **Only the repositories being migrated** (start with one disposable test repository), never "All repositories" |
| Release settings | `githubAppId`, `githubInstallations: "<owner>=<installation id>"` |

Token use, enforced in code (`src/scm/github.ts`) and tested (G1, G2):
- Control plane token: requested with exactly `{contents: read, statuses: write, metadata: read}`.
- Worker checkout token: a separate token requested with `{contents: read, metadata: read}`; used by the worker outside the job container; `.git` (and its credential config) is removed before the job starts.
- Owners without a configured installation are refused; there is no fallback credential (G3).

## Verified (tests in this repository)

| Behaviour | Test | Against |
|---|---|---|
| App JWT RS256 signature, `iss`, ≤ 10 min lifetime | G1 | local GitHub API stand-in that verifies the signature with the public key |
| Permission sets per token, token caching | G1, G2 | same stand-in |
| HTTP 403 and 5xx are never recorded as delivered; attempts and last error kept; delivery succeeds once access exists; the final state wins over a stale `pending` | G4, platform "status outbox" | stand-in + real feltdb-server |
| Webhook HMAC-SHA256 over raw bytes; tampered body, wrong secret, missing/sha1/truncated header rejected | G5, platform 01 | real code |
| Duplicate delivery (3 concurrent identical deliveries → 1 run) | platform 01 | real HTTP server + real feltdb-server |
| Trust: fork PRs untrusted; same-repo PRs trusted; branch deletes, non-CI events and missing delivery ids ignored | G6 | real code |
| Reading `.boundry/ci.yaml` at a commit and branch heads from real GitHub | M1 live slice (`f7cc5cd`) | **real api.github.com** (read path, through this session's proxy) |

## Not verified — blocker

**No status has been delivered to real GitHub.** This environment's GitHub proxy refuses status writes
(`HTTP 403 Write access to this GitHub API path is not permitted through this proxy`), and no Boundry CI
GitHub App exists yet. The outbox correctly keeps those statuses undelivered (it does not treat 403 as success).

To close it (owner): create the App as above, install it on one disposable repository, supply the key and
webhook secret, then on the host:

```bash
/opt/boundry-ci/bin/bci-deploy verify --no-canary
```

and push a commit with a minimal `.boundry/ci.yaml` to the test repository. Evidence of success: GitHub
"Recent deliveries" shows 2xx; `bci-deploy status` shows the run; the commit shows `boundry-ci` and
`boundry-ci/<job>` statuses; `statusOutbox.pending` returns to 0.

## Operator diagnostic for status delivery

```bash
/opt/boundry-ci/bin/bci-deploy status
```

`control.statusOutbox` reports `pending`, `failing` (attempted at least once), `oldestPendingSecondsAgo`,
and the last 10 failures as `{repository, sha, context, state, attempts, lastError}`. Per run:
`GET /v1/runs/<id>/statuses` (operator token). No token or secret appears in either.
