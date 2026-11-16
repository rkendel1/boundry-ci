#!/usr/bin/env bash
# WORKSTATION side (never on the shared host): build the control image for one commit and write a
# release bundle (release.json + compose.yml) that pins every image by config digest.
#   make-release.sh <out-dir> <feltdb-image-ref> <canary-image-ref> [settings.json]
# Requires: a clean checkout of rkendel1/boundry-ci at the commit to release, docker, node, and
# appboundry/deploy/boundry/image-identity.mjs (BCI_IDENTITY_SCRIPT).
set -euo pipefail
out=${1:?out-dir}; feltdb=${2:?feltdb image ref}; canary=${3:?canary image ref (digest-pinned)}; settings=${4:-}
here=$(cd "$(dirname "$0")/../.." && pwd); cd "$here"
identity=${BCI_IDENTITY_SCRIPT:?path to appboundry/deploy/boundry/image-identity.mjs}
[ -z "$(git status --porcelain)" ] || { echo "REFUSED: working tree is not clean" >&2; exit 2; }
rev=$(git rev-parse HEAD); id="$(date -u +%Y%m%dT%H%M%SZ)-${rev:0:12}"
case "$canary" in *@sha256:*) ;; *) echo "REFUSED: canary image must be digest-pinned" >&2; exit 2;; esac
tag="boundry-ci:${rev}"
if docker image inspect "$tag" >/dev/null 2>&1; then echo "using existing $tag"; else
  docker build ${BCI_BUILD_CA:+--secret id=build_ca,src=$BCI_BUILD_CA} --build-arg BCI_REVISION="$rev" -f deploy/Dockerfile -t "$tag" .
fi
digest() { node "$identity" identity "$1" | node -p 'JSON.parse(require("fs").readFileSync(0,"utf8")).configDigest'; }
mkdir -p "$out/$id"
node -e '
const [id, rev, ctl, cd, fdb, fd, can, kd, settingsFile] = process.argv.slice(1);
const defaults = { workerCapabilities: "linux-small,linux-build", ociCli: "podman", casMinFreeBytes: 21474836480, leaseMs: 60000, requireGithubApp: true };
const settings = { ...defaults, ...(settingsFile ? JSON.parse(require("fs").readFileSync(settingsFile, "utf8")) : {}) };
console.log(JSON.stringify({ releaseId: id, revision: rev, images: { control: { ref: ctl, configDigest: cd }, feltdb: { ref: fdb, configDigest: fd }, canary: { ref: can, configDigest: kd } }, settings }, null, 2));
' "$id" "$rev" "$tag" "$(digest "$tag")" "$feltdb" "$(digest "$feltdb")" "$canary" "$(digest "$canary")" "$settings" > "$out/$id/release.json"
cp deploy/hetzner/compose.yml "$out/$id/compose.yml"
echo "$out/$id"
