#!/usr/bin/env bash
# lab-cache: Redis is stopped and masked, so it does not come back on its own.
#
# The API keeps serving reads from Postgres, so the symptom is a degraded
# /health rather than an outage: a diagnosis has to read the per-dependency
# detail instead of stopping at the status code.

source "$(dirname "${BASH_SOURCE[0]}")/../scripts/common.sh"

HOST=lab-cache

apply() {
  log "breaking $HOST: stopping and masking redis-server"
  lab_root "$HOST" systemctl stop redis-server.service
  lab_root "$HOST" systemctl mask redis-server.service
  ok "$HOST: redis-server is stopped and masked"
}

check() {
  local state
  state="$(lab_ssh "$HOST" 'systemctl is-active redis-server.service' || true)"
  [ "$state" != "active" ] || die "redis-server is still active"

  local body
  body="$(curl -sk --max-time 5 https://127.0.0.1:8443/health || echo '{}')"
  grep -q '"status":"degraded"' <<<"$body" || die "lab-api /health does not report degraded: $body"
  grep -q '"redis":{"ok":false' <<<"$body" || die "/health does not name redis as the failing check: $body"

  ok "failure is live: redis $state, /health degraded on the redis check"
}

case "${1:-apply}" in
  --check) check ;;
  apply|'') apply ;;
  *) die "usage: $(basename "$0") [--check]" ;;
esac
