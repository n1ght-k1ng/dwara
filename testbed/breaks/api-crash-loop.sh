#!/usr/bin/env bash
# lab-api: the app cannot reach its database and restarts forever.
#
# The app's credentials are changed to something wrong. It exits at boot rather
# than serving traffic in a broken state, and systemd restarts it on a loop, so
# nginx has nothing to proxy to and returns 502.

source "$(dirname "${BASH_SOURCE[0]}")/../scripts/common.sh"

HOST=lab-api

apply() {
  log "breaking $HOST: wrong database password for the app"
  lab_root "$HOST" sed -i 's|labpass|definitely-not-the-password|' /etc/dwara-lab/app.env
  lab_root "$HOST" systemctl restart dwara-app.service
  ok "$HOST: dwara-app is now restarting on a loop"
}

check() {
  local first second
  first="$(lab_ssh "$HOST" 'systemctl show dwara-app.service -p NRestarts --value')"
  sleep 8
  second="$(lab_ssh "$HOST" 'systemctl show dwara-app.service -p NRestarts --value')"
  [ "$second" -gt "$first" ] || die "dwara-app is not restarting (NRestarts stayed at $first)"

  local code
  code="$(curl -sk -o /dev/null -w '%{http_code}' --max-time 5 https://127.0.0.1:8443/health || echo 000)"
  [ "$code" != "200" ] || die "lab-api /health still returns 200"

  ok "failure is live: NRestarts $first -> $second, /health -> $code"
}

case "${1:-apply}" in
  --check) check ;;
  apply|'') apply ;;
  *) die "usage: $(basename "$0") [--check]" ;;
esac
