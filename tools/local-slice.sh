#!/usr/bin/env bash
# Run the vertical slice with real processes: feltdb-server, `boundry-ci control`, `boundry-ci worker`,
# a signed GitHub push delivery for <repo>@<sha>, real GitHub API reads and commit statuses.
# Usage: tools/local-slice.sh <owner/repo> <sha> <branch>
# Env: FELTDB_SERVER_BIN, GitHub auth via BCI_GITHUB_* (or BCI_GITHUB_STATIC_TOKEN behind an injecting proxy),
#      optional BCI_EGRESS_CA_FILE. Leaves evidence in $WORK/evidence.json.
set -euo pipefail
repo=$1; sha=$2; branch=$3
here=$(cd "$(dirname "$0")/.." && pwd)
WORK=${WORK:-$(mktemp -d /tmp/bci-slice-XXXX)}
port_db=${PORT_DB:-7720}; port_cp=${PORT_CP:-21030}
mkdir -p "$WORK/secrets" "$WORK/repo-secrets" "$WORK/work"
chmod 700 "$WORK/secrets" "$WORK/repo-secrets"
pids=()
cleanup() { for p in "${pids[@]}"; do kill "$p" 2>/dev/null || true; done; [ -f "$WORK/feltdb/pid" ] && kill "$(cat "$WORK/feltdb/pid")" 2>/dev/null || true; }
trap cleanup EXIT

"$here/tools/feltdb-dev.sh" "$WORK/feltdb" "$port_db" >/dev/null
install -m 600 "$WORK/feltdb/token" "$WORK/secrets/feltdb-token"
head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' > "$WORK/secrets/webhook"; chmod 600 "$WORK/secrets/webhook"
op=$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')
printf '%s operator\n' "$(printf %s "$op" | sha256sum | cut -d' ' -f1)" > "$WORK/secrets/operators"; chmod 600 "$WORK/secrets/operators"

export BCI_FELTDB_URL=http://127.0.0.1:$port_db BCI_FELTDB_TOKEN_FILE=$WORK/secrets/feltdb-token
export BCI_WEBHOOK_SECRET_FILE=$WORK/secrets/webhook BCI_OPERATOR_TOKENS_FILE=$WORK/secrets/operators
export BCI_SECRETS_DIR=$WORK/repo-secrets BCI_DATA_DIR=$WORK/data BCI_LISTEN=127.0.0.1:$port_cp BCI_CAS_MIN_FREE_BYTES=0
export BCI_LEASE_MS=20000

node "$here/bin/boundry-ci.ts" admin create-worker hetzner-local linux-small linux-build > "$WORK/secrets/worker-token"
chmod 600 "$WORK/secrets/worker-token"
node "$here/bin/boundry-ci.ts" control > "$WORK/control.log" 2>&1 & pids+=($!)
for _ in $(seq 1 100); do curl -sf "http://127.0.0.1:$port_cp/readyz" >/dev/null && break; sleep 0.1; done
BCI_CONTROL_URL=http://127.0.0.1:$port_cp BCI_WORKER_TOKEN_FILE=$WORK/secrets/worker-token BCI_WORK_ROOT=$WORK/work \
  BCI_CAPABILITIES=linux-small,linux-build node "$here/bin/boundry-ci.ts" worker > "$WORK/worker.log" 2>&1 & pids+=($!)

payload=$(printf '{"ref":"refs/heads/%s","after":"%s","repository":{"full_name":"%s"},"sender":{"login":"local-slice"}}' "$branch" "$sha" "$repo")
sig=$(printf %s "$payload" | openssl dgst -sha256 -hmac "$(cat "$WORK/secrets/webhook")" | sed 's/^.* //')
resp=$(curl -sS -XPOST "http://127.0.0.1:$port_cp/webhooks/github" -H "x-github-event: push" -H "x-github-delivery: slice-$sha" \
  -H "x-hub-signature-256: sha256=$sig" --data-binary "$payload")
echo "intake: $resp"
run=$(printf %s "$resp" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).runId))')
for _ in $(seq 1 300); do
  st=$(curl -sf -H "authorization: Bearer $op" "http://127.0.0.1:$port_cp/v1/runs/$run" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).state))')
  [ "$st" != "running" ] && break; sleep 2
done
sleep 7 # one status-outbox cycle
curl -sf -H "authorization: Bearer $op" "http://127.0.0.1:$port_cp/v1/runs/$run" > "$WORK/run.json"
curl -sf -H "authorization: Bearer $op" "http://127.0.0.1:$port_cp/v1/runs/$run/jobs" > "$WORK/jobs.json"
curl -sf -H "authorization: Bearer $op" "http://127.0.0.1:$port_cp/v1/runs/$run/statuses" > "$WORK/statuses.json"
node -e '
const fs=require("fs"); const w=process.argv[1];
const run=JSON.parse(fs.readFileSync(w+"/run.json")); const jobs=JSON.parse(fs.readFileSync(w+"/jobs.json"));
console.log(JSON.stringify({run:{id:run.id,state:run.state,sha:run.sha,sourceDigest:run.sourceDigest,planDigest:run.planDigest},
 jobs:jobs.map(j=>({key:j.key,state:j.state,attempts:j.attempts,attemptId:j.attemptId,reason:j.reason}))},null,2))' "$WORK" | tee "$WORK/evidence.json"
for a in $(node -e 'for (const j of JSON.parse(require("fs").readFileSync(process.argv[1]))) console.log(j.attemptId)' "$WORK/jobs.json"); do
  curl -sf -H "authorization: Bearer $op" "http://127.0.0.1:$port_cp/v1/attempts/$a/log" > "$WORK/log-$a.txt"
done
echo "evidence in $WORK"
