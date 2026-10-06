#!/usr/bin/env bash
# lab-api: the image store has accumulated untagged images.
#
# Count rather than bytes, deliberately. /var/lib/docker is a volume on the
# developer's disk with hundreds of gigabytes free, so a scenario that claimed
# the image cache had filled a disk would be lying about the lab -- and a break
# that genuinely filled it would eat the developer's machine.
#
# Dangling images are made with `docker commit`, which produces an image with no
# repository or tag by definition. Two other approaches were measured and do not
# work on this engine:
#
#   - `docker rmi --no-prune <tag>` deletes the image outright when it has one tag
#     and no children; --no-prune only spares untagged *parents*.
#   - Rebuilding the same tag leaves **zero** dangling images. BuildKit drops the
#     replaced image rather than untagging it, so the classic "retag and the old
#     one goes dangling" behaviour is simply not there.
#
# The source is the app image already on the host, so the break needs no network.
# Committing from it shares layers, which is why the space reclaimed later is
# tiny -- the scenario is about the count, and says so.
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

log "breaking lab-api: committing 6 untagged images"
lab_root lab-api bash -c '
  for i in $(seq 1 6); do
    cid=$(docker create dwara-lab-app:dev /bin/true) || continue
    docker commit "$cid" >/dev/null 2>&1 || true
    # Removed, because `docker image prune` skips an image a container still
    # references -- leaving these would make the scenario unsolvable.
    docker rm -f "$cid" >/dev/null 2>&1 || true
  done'
ok "lab-api: untagged images are piling up"
