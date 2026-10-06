#!/usr/bin/env bash
# Resolved when lab-api serves /health again through nginx.
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

# Wrapped in a function so `settle` re-evaluates it on each attempt.
#
# `settle 10 test "$(http_status lab-api)" = 502` does NOT work: the command
# substitution is expanded once, when settle's arguments are built, so every
# retry compares the same stale value and the retry is a no-op. That is exactly
# the bug the retry existed to avoid.
serves() {
  [ "$(http_status lab-api)" = "$1" ]
}

if [ "$MODE" = "--broken" ]; then
  settle 10 serves 502 || fail "expected 502 from lab-api, got $(http_status lab-api)"
  lab_root lab-api nginx -t >/dev/null 2>&1 \
    || fail "nginx config should still validate; this scenario is a wrong port, not a syntax error"
  pass "failure is live: /health -> 502 while nginx -t still passes"
fi

settle 10 serves 200 || fail "lab-api /health returns $(http_status lab-api), not 200"
lab_root lab-api nginx -t >/dev/null 2>&1 || fail "nginx config is no longer valid"
pass "lab-api serves /health with a valid nginx config"
