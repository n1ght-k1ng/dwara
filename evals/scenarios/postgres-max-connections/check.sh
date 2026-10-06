#!/usr/bin/env bash
# Resolved when the app can reach the database again.
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

psql_admin() {
  local out
  out="$(lab_root lab-db su - postgres -c "psql -tAc \"$1\"" 2>/dev/null)" || true
  printf '%s' "$out"
}

limit() { psql_admin 'SHOW max_connections' | tr -dc '0-9'; }

if [ "$MODE" = "--broken" ]; then
  [ "$(limit)" -le 5 ] || fail "max_connections is $(limit), expected 5"
  settle 20 bash -c 'test "$(docker exec lab-api curl -sk -o /dev/null -w %{http_code} --max-time 10 https://127.0.0.1/health 2>/dev/null)" != 200' \
    || fail "lab-api /health still returns 200"
  pass "failure is live: max_connections=$(limit) and lab-api cannot get a slot"
fi

[ "$(limit)" -gt 5 ] || fail "max_connections is still $(limit)"
settle 20 is_active lab-db postgresql@16-main.service \
  || fail "postgres is $(unit_state lab-db postgresql@16-main.service)"
settle 20 serves lab-api 200 || fail "lab-api /health is $(http_status lab-api), not 200"
pass "max_connections raised to $(limit) and lab-api serves /health"
