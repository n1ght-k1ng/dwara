#!/usr/bin/env bash
# Resolved when the journal has been shrunk and /var/log has room again.
#
# Measured with `du`, deliberately, NOT with `journalctl --disk-usage`. That
# command over-reports: on a 128 MB filesystem it claimed 143M and at one point
# 189.7M -- more than the filesystem can hold -- and an earlier version of this
# check believed it, so a successful fix was scored as a failure. `du` is ground
# truth, and it is also what `disk_usage` shows the agent.
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

journal_mb() {
  local out
  out="$(lab_root lab-api du -sm /var/log/journal 2>/dev/null | cut -f1)" || true
  printf '%s' "${out:-0}"
}

if [ "$MODE" = "--broken" ]; then
  mb="$(journal_mb)"
  [ "${mb:-0}" -ge 80 ] || fail "the journal is only ${mb}MB; the break did not take"
  used="$(disk_used_percent lab-api /var/log)"
  # 80, not 90: journald reserves ~15% of the filesystem and will not fill past
  # about 85% however high SystemMaxUse is. See break.sh for the measurements.
  [ "${used:-0}" -ge 80 ] || fail "/var/log is only ${used}% full with a ${mb}MB journal"
  pass "failure is live: a ${mb}MB journal and /var/log ${used}% full"
fi

mb="$(journal_mb)"
[ "${mb:-999}" -le 40 ] || fail "the journal is still ${mb}MB"
used="$(disk_used_percent lab-api /var/log)"
[ "${used:-100}" -lt 70 ] || fail "/var/log is still ${used}% full"
pass "the journal is ${mb}MB and /var/log is ${used}% used"
