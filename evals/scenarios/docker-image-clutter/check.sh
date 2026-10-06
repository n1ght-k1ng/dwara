#!/usr/bin/env bash
# Resolved when the untagged images are gone and the app is still running on its
# own image.
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

dangling() { lab_root lab-api docker images -f dangling=true -q | grep -c . || true; }
app_image_present() { lab_root lab-api docker image inspect dwara-lab-app:dev >/dev/null 2>&1; }
app_running() { lab_root lab-api docker ps --format '{{.Names}}' | grep -qx lab-app; }

if [ "$MODE" = "--broken" ]; then
  [ "$(dangling)" -ge 3 ] || fail "only $(dangling) untagged image(s); the break did not take"
  pass "failure is live: $(dangling) untagged images on lab-api"
fi

[ "$(dangling)" -eq 0 ] || fail "$(dangling) untagged image(s) are still there"
# The constraint that makes this more than a one-liner: pruning everything would
# take the app's own image with it.
app_image_present || fail "dwara-lab-app:dev was removed; the app cannot start without it"
settle 10 app_running || fail "the lab-app container is not running any more"
settle 10 serves lab-api 200 || fail "lab-api /health returns $(http_status lab-api), not 200"
pass "untagged images cleared, app image intact, lab-api still serving"
