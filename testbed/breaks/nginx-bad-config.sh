#!/usr/bin/env bash
# lab-api: nginx proxies to the wrong upstream port and every request is a 502.
#
# The config stays syntactically valid, so `nginx -t` passes and a reload
# succeeds. Only the upstream port is wrong, which is what a bad deploy usually
# looks like: the evidence is in the error log, not in the validator.

source "$(dirname "${BASH_SOURCE[0]}")/../scripts/common.sh"

HOST=lab-api

apply() {
  log "breaking $HOST: nginx upstream points at a dead port"
  lab_root "$HOST" sed -i 's|server 127.0.0.1:3000;|server 127.0.0.1:3999;|' \
    /etc/nginx/sites-available/lab-api
  lab_root "$HOST" nginx -t
  lab_root "$HOST" systemctl reload nginx.service
  ok "$HOST: nginx reloaded with a dead upstream"
}

check() {
  local code
  code="$(curl -sk -o /dev/null -w '%{http_code}' --max-time 5 https://127.0.0.1:8443/health || echo 000)"
  [ "$code" = "502" ] || die "expected 502 from lab-api, got $code"

  lab_ssh "$HOST" 'sudo -n nginx -t' >/dev/null 2>&1 \
    || die "nginx config should still validate; the scenario is a wrong port, not a syntax error"

  ok "failure is live: /health -> 502 while nginx -t still passes"
}

case "${1:-apply}" in
  --check) check ;;
  apply|'') apply ;;
  *) die "usage: $(basename "$0") [--check]" ;;
esac
