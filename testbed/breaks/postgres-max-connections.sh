#!/usr/bin/env bash
# lab-db: connection slots are exhausted and the app can no longer reach the database.
#
# The symptom shows up on lab-api as a 502, but nothing is wrong there: the app
# cannot get a connection at boot, so it exits and restarts. Postgres itself is
# active and its port is open, which is the confusing part. The evidence that
# separates this from api-crash-loop is in the app's journal -- "remaining
# connection slots are reserved" rather than an authentication failure.
#
# The superuser reserve is left intact, so an operator can still connect to
# lab-db to diagnose it.

source "$(dirname "${BASH_SOURCE[0]}")/../scripts/common.sh"

HOST=lab-db
# max_connections minus superuser_reserved_connections: the slots an ordinary
# role such as the app's can use.
APP_SLOTS=2

psql_admin() {
  lab_root "$HOST" su - postgres -c "psql -tAc \"$1\""
}

apply() {
  log "breaking $HOST: max_connections=5 with every application slot held open"
  lab_root "$HOST" bash -c "printf 'max_connections = 5\nsuperuser_reserved_connections = 3\n' \
    > /etc/postgresql/16/main/conf.d/90-dwara-break.conf"
  lab_root "$HOST" systemctl restart postgresql@16-main.service
  lab_root "$HOST" bash -c 'until pg_isready -q; do sleep 1; done'

  # The app's pool competes for the same slots and releases them when idle, so
  # each holder retries until it wins one.
  for _ in $(seq "$APP_SLOTS"); do
    lab_root "$HOST" bash -c \
      'setsid nohup bash -c "while true; do PGPASSWORD=labpass psql -h 127.0.0.1 -U labapp -d labdb -c \"SELECT pg_sleep(3600)\" >/dev/null 2>&1; sleep 1; done" >/dev/null 2>&1 &'
  done

  local held deadline=$(( SECONDS + 60 ))
  while :; do
    held="$(psql_admin "SELECT count(*) FROM pg_stat_activity WHERE usename = 'labapp'" | tr -dc '0-9')"
    [ "${held:-0}" -lt "$APP_SLOTS" ] || break
    [ "$SECONDS" -lt "$deadline" ] || die "only held ${held:-0}/$APP_SLOTS application slots"
    sleep 2
  done

  ok "$HOST: $held/$APP_SLOTS application connection slots held"
}

check() {
  local limit
  limit="$(psql_admin 'SHOW max_connections' | tr -dc '0-9')"
  [ "$limit" -le 5 ] || die "max_connections is $limit, expected 5"

  local state
  state="$(lab_ssh "$HOST" 'systemctl is-active postgresql@16-main.service' || true)"
  [ "$state" = "active" ] || warn "postgres is $state; the scenario expects it to stay active"

  local code
  code="$(curl -sk -o /dev/null -w '%{http_code}' --max-time 10 https://127.0.0.1:8443/health || echo 000)"
  [ "$code" != "200" ] || die "lab-api /health still returns 200"

  local deadline=$(( SECONDS + 60 ))
  until lab_ssh lab-api 'sudo -n journalctl -u dwara-app -n 50 --no-pager' 2>/dev/null \
        | grep -q 'remaining connection slots are reserved'; do
    [ "$SECONDS" -lt "$deadline" ] || die "lab-api's journal never showed a connection-slot failure"
    sleep 3
  done

  ok "failure is live: max_connections=$limit, postgres $state, lab-api -> $code on exhausted slots"
}

case "${1:-apply}" in
  --check) check ;;
  apply|'') apply ;;
  *) die "usage: $(basename "$0") [--check]" ;;
esac
