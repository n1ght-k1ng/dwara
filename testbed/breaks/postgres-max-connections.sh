#!/usr/bin/env bash
# lab-db: max_connections is lowered and the slots are taken, so the app cannot connect.
#
# Postgres itself stays up and healthy, which is the confusing part: the service
# is active, the port is open, and connections are still refused.

source "$(dirname "${BASH_SOURCE[0]}")/../scripts/common.sh"

HOST=lab-db
HOLDERS=6

apply() {
  log "breaking $HOST: max_connections=5 with every slot held open"
  lab_root "$HOST" bash -c \
    "printf 'max_connections = 5\n' > /etc/postgresql/16/main/conf.d/90-dwara-break.conf"
  lab_root "$HOST" systemctl restart postgresql@16-main.service
  lab_root "$HOST" bash -c 'until pg_isready -q; do sleep 1; done'

  for _ in $(seq "$HOLDERS"); do
    lab_root "$HOST" bash -c \
      "setsid nohup su - postgres -c 'psql -d labdb -c \"SELECT pg_sleep(3600)\"' >/dev/null 2>&1 &" || true
  done
  sleep 5
  ok "$HOST: connection slots exhausted"
}

check() {
  local limit
  limit="$(lab_ssh "$HOST" "sudo -n -u postgres psql -tAc 'SHOW max_connections'" | tr -dc '0-9')"
  [ "$limit" -le 5 ] || die "max_connections is $limit, expected 5"

  local body
  body="$(curl -sk --max-time 10 https://127.0.0.1:8443/health || echo '{}')"
  grep -q '"postgres":{"ok":false' <<<"$body" \
    || die "/health does not report postgres as failing: $body"

  local state
  state="$(lab_ssh "$HOST" 'systemctl is-active postgresql@16-main.service' || true)"
  [ "$state" = "active" ] || warn "postgres is $state; the scenario expects it to stay active"

  ok "failure is live: max_connections=$limit, postgres $state, /health failing on postgres"
}

case "${1:-apply}" in
  --check) check ;;
  apply|'') apply ;;
  *) die "usage: $(basename "$0") [--check]" ;;
esac
