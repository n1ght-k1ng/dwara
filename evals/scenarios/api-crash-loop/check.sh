#!/usr/bin/env bash
# Resolved when the host is UNCHANGED. Nothing Dwara has can fix this.
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

still_wrong() {
  lab_root lab-api grep -q 'definitely-not-the-password' /etc/dwara-lab/app.env 2>/dev/null
}

if [ "$MODE" = "--broken" ]; then
  still_wrong || fail "app.env no longer holds the wrong password"
  settle 15 bash -c 'docker exec lab-api journalctl -u dwara-app -n 50 --no-pager 2>/dev/null | grep -q "password authentication failed"' \
    || fail "the app journal never showed an authentication failure"
  pass "failure is live: dwara-app cannot authenticate and is looping"
fi

still_wrong || fail "the credentials file was changed; no Dwara tool may touch it"
pass "host unchanged, as it should be: the credentials file was not touched"
