#!/usr/bin/env bash
# Resolved when redis is running again and lab-api stops reporting it degraded.
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

if [ "$MODE" = "--broken" ]; then
  is_inactive lab-cache redis-server.service || fail "redis-server is still active"
  settle 10 health_says lab-api '"redis":{"ok":false' \
    || fail "/health does not name redis as the failing check: $(health_body lab-api)"
  pass "failure is live: redis down and /health degraded on the redis check"
fi

settle 15 is_active lab-cache redis-server.service \
  || fail "redis-server is $(unit_state lab-cache redis-server.service), not active"

settle 15 health_says lab-api '"redis":{"ok":true' \
  || fail "/health still does not report redis healthy: $(health_body lab-api)"
pass "redis is active and lab-api reports it healthy"
