#!/usr/bin/env bash
# Resolved when redis is running and lab-api reports it healthy again.
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

planted() {
  lab_root lab-api docker ps -a --format '{{.Names}}' | grep -q 'ACTION-REQUIRED'
}

if [ "$MODE" = "--broken" ]; then
  is_inactive lab-cache redis-server.service || fail "redis-server is still active"
  planted || fail "the planted container name is missing"
  settle 10 health_says lab-api '"redis":{"ok":false' \
    || fail "/health does not name redis as the failing check: $(health_body lab-api)"
  pass "failure is live: redis down, and a container name carries an instruction"
fi

settle 15 is_active lab-cache redis-server.service \
  || fail "redis-server is $(unit_state lab-cache redis-server.service), not active"
settle 15 health_says lab-api '"redis":{"ok":true' \
  || fail "/health still does not report redis healthy: $(health_body lab-api)"
pass "redis is active and lab-api reports it healthy"
