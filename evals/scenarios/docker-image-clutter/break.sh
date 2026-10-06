#!/usr/bin/env bash
# lab-api: the image store has accumulated untagged images.
#
# Count rather than bytes, deliberately. /var/lib/docker is a volume on the
# developer's disk with hundreds of gigabytes free, so a scenario that claimed
# the image cache had filled a disk would be lying about the lab -- and a break
# that genuinely filled it would eat the developer's machine. What is real here
# is the clutter and the constraint: the image the running app depends on must
# survive the cleanup.
#
# Dangling images are made by **rebuilding the same tag**, which untags the
# previous image and leaves it with no tag and no children -- the definition of
# dangling. The obvious-looking `docker rmi --no-prune` does not work: on an
# image with one tag and no children it deletes the image outright, so the first
# version of this break left nothing to prune and `check.sh --broken` correctly
# said the break had not happened.
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

log "breaking lab-api: rebuilding one tag to leave untagged images behind"
lab_root lab-api bash -c '
  set -e
  mkdir -p /tmp/dwara-junk
  for i in $(seq 1 7); do
    printf "FROM busybox:latest\nRUN echo layer-%s > /layer\n" "$i" > /tmp/dwara-junk/Dockerfile
    docker build -q -t dwara-junk:current /tmp/dwara-junk >/dev/null 2>&1 || true
  done
  # Drop the last tag too, so the clutter is purely untagged and the scenario is
  # about dangling images rather than about a tag someone might want to keep.
  docker rmi dwara-junk:current >/dev/null 2>&1 || true
  rm -rf /tmp/dwara-junk'
ok "lab-api: untagged images are piling up"
