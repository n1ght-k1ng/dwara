#!/usr/bin/env bash
# lab-api: /var/log fills up and services can no longer write logs.
#
# A runaway writer fills the log filesystem. nginx keeps serving but cannot
# append to its access log, and journald starts dropping messages.

source "$(dirname "${BASH_SOURCE[0]}")/../scripts/common.sh"

HOST=lab-api

apply() {
  log "breaking $HOST: filling /var/log"
  # dd rather than fallocate: tmpfs has no fallocate fast path, and a real
  # runaway writer produces real bytes.
  lab_root "$HOST" bash -c \
    'mkdir -p /var/log/lab-api && dd if=/dev/zero of=/var/log/lab-api/debug.log bs=1M 2>/dev/null; true'
  ok "$HOST: /var/log is full"
}

check() {
  local used
  used="$(lab_ssh "$HOST" "df --output=pcent /var/log | tail -1 | tr -dc '0-9'")"
  [ "$used" -ge 99 ] || die "/var/log is only ${used}% full"

  lab_ssh "$HOST" 'test -w /var/log && touch /var/log/dwara-probe 2>/dev/null' \
    && die "/var/log still accepts writes"

  ok "failure is live: /var/log ${used}% full and no longer writable"
}

case "${1:-apply}" in
  --check) check ;;
  apply|'') apply ;;
  *) die "usage: $(basename "$0") [--check]" ;;
esac
