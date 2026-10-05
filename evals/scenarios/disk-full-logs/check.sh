#!/usr/bin/env bash
# Resolved when /var/log can be written to again.
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

if [ "$MODE" = "--broken" ]; then
  used="$(disk_used_percent lab-api /var/log)"
  [ "$used" -ge 99 ] || fail "/var/log is only ${used}% full"
  pass "failure is live: /var/log ${used}% full"
fi

used="$(disk_used_percent lab-api /var/log)"
[ "$used" -lt 95 ] || fail "/var/log is still ${used}% full"

# Headroom in bytes, not a touch probe: a tmpfs at 99% still accepts an empty
# file, so a touch proves nothing about whether a service can append a log line.
avail="$(lab_root lab-api sh -c "df --output=avail /var/log | tail -1" 2>/dev/null || echo 0)"
[ "${avail:-0}" -gt 10000 ] || fail "only ${avail}KB free on /var/log"
pass "/var/log is ${used}% used with ${avail}KB free"
