#!/usr/bin/env bash
# Resolved when lab-staging serves /health through nginx again.
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

running() { lab_root lab-staging docker ps --format '{{.Names}}' | grep -qx lab-app; }

if [ "$MODE" = "--broken" ]; then
  running && fail "the lab-app container is still running on lab-staging"
  settle 10 serves lab-staging 502 \
    || fail "expected 502 from lab-staging, got $(http_status lab-staging)"
  pass "failure is live: no app container and /health is 502"
fi

# `systemctl start` on this unit returns as soon as `docker run` has forked. The
# container took 15 seconds to appear and the app a moment more to listen, so
# both of these are retried -- an immediate check here reported a correct fix as
# a failure.
settle 20 running || fail "the lab-app container is not running on lab-staging"
settle 20 serves lab-staging 200 \
  || fail "lab-staging /health returns $(http_status lab-staging), not 200"
pass "lab-staging serves /health with the app container running"
