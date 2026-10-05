#!/usr/bin/env bash
# lab-api: /var/log fills up and services can no longer write.
#
# A runaway writer fills the log filesystem with one enormous line. nginx keeps
# serving but cannot append to its access log, and journald starts dropping
# messages.
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

log "breaking lab-api: filling /var/log"
# dd rather than fallocate: tmpfs has no fallocate fast path, and a real runaway
# writer produces real bytes.
lab_root lab-api bash -c \
  'mkdir -p /var/log/lab-api && dd if=/dev/zero of=/var/log/lab-api/debug.log bs=1M 2>/dev/null; true'
ok "lab-api: /var/log is full"
