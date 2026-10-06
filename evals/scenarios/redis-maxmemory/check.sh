#!/usr/bin/env bash
# Resolved when Redis accepts a 2 MB write again.
#
# The probe is a single 2 MB SET rather than a measurement of how much is stored,
# so it does not depend on what happens to be in the cache: over the limit it
# fails with OOM, under it succeeds, and a restart does not change the answer. A
# check that read the dataset size would pass for the wrong reason every time
# Redis was restarted and came back empty.
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

accepts_write() {
  lab_root lab-cache sh -c \
    'dd if=/dev/zero bs=1M count=2 2>/dev/null | tr "\0" x | redis-cli -x set dwara_probe 2>&1' \
    | grep -q '^OK'
}

clear_probe() { lab_root lab-cache redis-cli del dwara_probe >/dev/null 2>&1 || true; }

if [ "$MODE" = "--broken" ]; then
  accepts_write && { clear_probe; fail "Redis still accepts a 2MB write"; }
  lab_root lab-cache redis-cli ping 2>/dev/null | grep -q PONG \
    || fail "Redis is not answering PING; this scenario needs it up and refusing writes"
  pass "failure is live: Redis answers PING but refuses a 2MB write"
fi

# Retried: edit_config restarts Redis, and it does not accept connections the
# instant systemctl returns.
settle 15 accepts_write || { clear_probe; fail "Redis still refuses a 2MB write"; }
clear_probe
pass "Redis accepts writes again"
