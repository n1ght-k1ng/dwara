#!/usr/bin/env bash
# lab-api: the image store has accumulated untagged images.
#
# Count rather than bytes, deliberately. /var/lib/docker is a volume on the
# developer's disk with hundreds of gigabytes free, so a scenario that claimed
# the image cache had filled a disk would be lying about the lab -- and a break
# that genuinely filled it would eat the developer's machine. What is real here
# is the clutter and the constraint: the image the running app depends on must
# survive the cleanup.
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

log "breaking lab-api: building 6 untagged images"
lab_root lab-api bash -c '
  set -e
  for i in $(seq 1 6); do
    printf "FROM busybox:latest\nRUN echo layer-%s > /layer\n" "$i" > /tmp/Dockerfile.$i
    docker build -q -f /tmp/Dockerfile.$i -t dwara-junk:$i /tmp >/dev/null 2>&1 || true
    docker rmi --no-prune dwara-junk:$i >/dev/null 2>&1 || true
    rm -f /tmp/Dockerfile.$i
  done' || true
ok "lab-api: untagged images are piling up"
