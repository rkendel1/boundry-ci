#!/usr/bin/env bash
# Start a disposable, authenticated feltdb-server for local tests.
# Usage: tools/feltdb-dev.sh <dataDir> <port>
# Prints: FELTDB_URL and FELTDB_TOKEN lines (token written only to <dataDir>/token).
# Requires FELTDB_SERVER_BIN (path to a feltdb-server built from rkendel1/flow_db).
set -euo pipefail
dir=$1; port=$2
bin=${FELTDB_SERVER_BIN:?set FELTDB_SERVER_BIN to a feltdb-server binary}
rm -rf "$dir"; mkdir -p "$dir"
# Never inherit a production FeltDB configuration from the calling environment.
clean_env=(env -u FELTDB_URL -u FELTDB_TOKEN -u FELTDB_API_KEY -u FELTDB_APPLICATION_ID -u FELTDB_NAMESPACE
  FELTDB_ENVIRONMENT=development FELTDB_MASTER_KEY=disposable-test-key-$RANDOM$RANDOM)
"${clean_env[@]}" "$bin" keys create --keys "$dir/keys.json" --name boundry-ci-test --scope '*' --namespace boundry-ci | tail -1 > "$dir/token"
"${clean_env[@]}" "$bin" --host 127.0.0.1 --port "$port" --namespace boundry-ci --data "$dir/data/feltdb.log" \
  --auth --keys "$dir/keys.json" > "$dir/server.log" 2>&1 &
echo $! > "$dir/pid"
for _ in $(seq 1 100); do curl -sf "http://127.0.0.1:$port/ready" >/dev/null && break; sleep 0.1; done
curl -sf "http://127.0.0.1:$port/ready" >/dev/null || { cat "$dir/server.log" >&2; exit 1; }
echo "FELTDB_URL=http://127.0.0.1:$port"
