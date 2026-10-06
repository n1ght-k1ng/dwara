#!/usr/bin/env bash
# Resolved when nginx is running and lab-api serves /health again.
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

if [ "$MODE" = "--broken" ]; then
  is_inactive lab-api nginx.service \
    || fail "nginx should be stopped, it is $(unit_state lab-api nginx.service)"
  settle 5 serves lab-api 000 || fail "lab-api still answers on 443: $(http_status lab-api)"
  pass "failure is live: nginx stopped and nothing answers on 443"
fi

settle 15 is_active lab-api nginx.service \
  || fail "nginx is $(unit_state lab-api nginx.service), not active"
settle 15 serves lab-api 200 || fail "lab-api /health returns $(http_status lab-api), not 200"
pass "nginx is running and lab-api serves /health"
