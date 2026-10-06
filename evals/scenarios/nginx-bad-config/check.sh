#!/usr/bin/env bash
# Resolved when lab-api serves /health again through nginx.
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

# `serves` comes from lib.sh, and it is a function for a reason:
# `settle 10 test "$(http_status lab-api)" = 502` does NOT work -- the command
# substitution is expanded once, when settle's arguments are built, so every
# retry compares the same stale value. That is exactly the bug the retry existed
# to avoid.

if [ "$MODE" = "--broken" ]; then
  settle 10 serves lab-api 502 || fail "expected 502 from lab-api, got $(http_status lab-api)"
  lab_root lab-api nginx -t >/dev/null 2>&1 \
    || fail "nginx config should still validate; this scenario is a wrong port, not a syntax error"
  pass "failure is live: /health -> 502 while nginx -t still passes"
fi

settle 10 serves lab-api 200 || fail "lab-api /health returns $(http_status lab-api), not 200"
lab_root lab-api nginx -t >/dev/null 2>&1 || fail "nginx config is no longer valid"
pass "lab-api serves /health with a valid nginx config"
