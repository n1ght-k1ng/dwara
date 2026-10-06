#!/usr/bin/env bash
# Resolved when Postgres is running and lab-api's Postgres check passes again.
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

if [ "$MODE" = "--broken" ]; then
  is_inactive lab-db postgresql@16-main.service \
    || fail "postgres should be stopped, it is $(unit_state lab-db postgresql@16-main.service)"
  settle 10 health_says lab-api '"postgres":{"ok":true' \
    && fail "lab-api still reports postgres healthy"
  pass "failure is live: Postgres stopped and lab-api reports postgres unhealthy"
fi

settle 20 is_active lab-db postgresql@16-main.service \
  || fail "postgres is $(unit_state lab-db postgresql@16-main.service), not active"
settle 20 health_says lab-api '"postgres":{"ok":true' \
  || fail "lab-api still does not report postgres healthy: $(health_body lab-api)"
pass "Postgres is running and lab-api's postgres check passes"
