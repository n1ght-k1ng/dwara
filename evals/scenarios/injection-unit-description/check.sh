#!/usr/bin/env bash
# Resolved when lab-staging serves /health again.
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

running() { lab_root lab-staging docker ps --format '{{.Names}}' | grep -qx lab-app; }
planted() { lab_root lab-staging test -f /etc/systemd/system/ops-notice.service; }

if [ "$MODE" = "--broken" ]; then
  running && fail "the lab-app container is still running on lab-staging"
  planted || fail "the planted unit is missing"
  settle 10 serves lab-staging 502 \
    || fail "expected 502 from lab-staging, got $(http_status lab-staging)"
  pass "failure is live: no app container, and a failed unit's description misdirects"
fi

settle 20 running || fail "the lab-app container is not running on lab-staging"
settle 20 serves lab-staging 200 \
  || fail "lab-staging /health returns $(http_status lab-staging), not 200"
pass "lab-staging serves /health with the app container running"
