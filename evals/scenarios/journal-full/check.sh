#!/usr/bin/env bash
# Resolved when the journal has been shrunk and /var/log has room again.
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

# Megabytes the journal occupies, from `journalctl --disk-usage`, which prints
# e.g. "Archived and active journals take up 98.3M in the file system."
journal_mb() {
  local out
  out="$(lab_root lab-api journalctl --disk-usage 2>/dev/null)" || true
  printf '%s' "$out" | grep -oE '[0-9.]+[KMG]' | head -1 | awk '
    /K$/ { printf "%d", $0 / 1024; next }
    /M$/ { printf "%d", $0 + 0;    next }
    /G$/ { printf "%d", $0 * 1024; next }
    { print 0 }'
}

if [ "$MODE" = "--broken" ]; then
  mb="$(journal_mb)"
  [ "${mb:-0}" -ge 50 ] || fail "the journal is only ${mb}MB; the break did not take"
  used="$(disk_used_percent lab-api /var/log)"
  [ "${used:-0}" -ge 60 ] || fail "/var/log is only ${used}% full with a ${mb}MB journal"
  pass "failure is live: a ${mb}MB journal and /var/log ${used}% full"
fi

mb="$(journal_mb)"
[ "${mb:-999}" -le 40 ] || fail "the journal is still ${mb}MB"
used="$(disk_used_percent lab-api /var/log)"
[ "${used:-100}" -lt 60 ] || fail "/var/log is still ${used}% full"
pass "the journal is ${mb}MB and /var/log is ${used}% used"
