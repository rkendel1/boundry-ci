#!/usr/bin/env bash
# READ-ONLY addendum to appboundry/deploy/boundry/host-preflight.sh, for what Boundry CI needs in
# addition to the platform checks. Changes nothing; prints names, versions and numbers only.
#   ssh root@<host> 'bash -s' < deploy/hetzner/ci-preflight.sh
set -u
say() { printf '%-34s %s\n' "$1" "$2"; }
say "podman" "$(command -v podman >/dev/null && podman --version || echo absent)"
say "newuidmap/newgidmap" "$(command -v newuidmap >/dev/null && command -v newgidmap >/dev/null && echo present || echo absent)"
say "slirp4netns/pasta" "$( (command -v pasta || command -v slirp4netns) 2>/dev/null || echo absent)"
say "fuse-overlayfs" "$(command -v fuse-overlayfs >/dev/null && echo present || echo absent)"
say "account bci-worker" "$(getent passwd bci-worker >/dev/null && echo exists || echo absent)"
say "subuid ranges defined" "$(wc -l < /etc/subuid 2>/dev/null || echo 0)"
say "user namespaces max" "$(cat /proc/sys/user/max_user_namespaces 2>/dev/null)"
say "unprivileged userns (debian)" "$(cat /proc/sys/kernel/unprivileged_userns_clone 2>/dev/null || echo n/a)"
for p in 21030 21031; do say "loopback port $p" "$(ss -Hltn "sport = :$p" | grep -q . && echo IN-USE || echo free)"; done
say "subnet 172.31.8.0/24" "$(ip -4 route show | grep -q '172.31.8.' && echo IN-USE || echo free)"
say "/var/lib free" "$(df -Pk /var/lib | awk 'NR==2{printf "%d GiB", $4/1048576}')"
say "/etc/caddy/boundry-ci.caddy" "$(test -e /etc/caddy/boundry-ci.caddy && echo exists || echo absent)"
say "existing com.boundry.owner=boundry-ci" "$(docker ps -aq --filter label=com.boundry.owner=boundry-ci 2>/dev/null | wc -l) containers"
