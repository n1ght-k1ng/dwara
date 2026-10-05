#!/usr/bin/env bash
# Resolved when redis is running again and lab-api stops reporting it degraded.
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

if [ "$MODE" = "--broken" ]; then
  [ "$(unit_state lab-cache redis-server.service)" != "active" ] \
    || fail "redis-server is still active"
  settle 10 bash -c 'grep -q "\"redis\":{\"ok\":false" <<<"$(docker exec lab-api curl -sk --max-time 5 https://127.0.0.1/health 2>/dev/null)"' \
    || fail "/health does not name redis as the failing check: $(health_body lab-api)"
  pass "failure is live: redis down and /health degraded on the redis check"
fi

[ "$(unit_state lab-cache redis-server.service)" = "active" ] \
  || fail "redis-server is $(unit_state lab-cache redis-server.service), not active"

settle 10 bash -c 'grep -q "\"redis\":{\"ok\":true" <<<"$(docker exec lab-api curl -sk --max-time 5 https://127.0.0.1/health 2>/dev/null)"' \
  || fail "/health still does not report redis healthy: $(health_body lab-api)"
pass "redis is active and lab-api reports it healthy"
