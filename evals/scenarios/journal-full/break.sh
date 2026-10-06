#!/usr/bin/env bash
# lab-api: the systemd journal has eaten the log filesystem.
#
# Distinct from disk-full-logs in both cause and cure. There the culprit is one
# runaway application file and the fix is to truncate it by name; here it is the
# journal itself, which has no file an agent should be truncating -- the only
# correct move is rotate_logs' journal mode.
#
# The journal defaults to 10% of its filesystem, which on a 128 MB tmpfs is about
# 12 MB and cannot fill anything. So the break raises SystemMaxUse first, which is
# also the realistic version of this outage: somebody lifted the cap. Rate
# limiting goes too, or journald throttles the flood and the break quietly does
# not happen.
#
# **Few large lines, and incompressible.** Two measured constraints:
#   - 75 MB of default-width base64 is ~1.3 million journal entries and took
#     minutes, which is unusable in a benchmark that resets per scenario. At
#     `-w 40000` it is ~2,600 entries and takes one second.
#   - The payload has to be random. journald compresses large fields, so padding
#     with a repeated character writes almost nothing to disk.
#   - 40,000 is under journald's default LineMax of 48K, so nothing is split.
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

log "breaking lab-api: lifting the journal cap and filling it"

# **journald will not fill the last ~15% of the filesystem, and that is a floor.**
# Measured: SystemMaxUse=96M gives 84 MB and 66% full; SystemMaxUse=120M gives
# 109 MB and 85%, which is 128 - 19 = the default SystemKeepFree reserve. Setting
# SystemKeepFree=2M does not move it, so it is not set here rather than left in as
# config that does nothing.
#
# 85% with 20 MB free on a log partition is what this outage actually looks like,
# and the check is written to that number instead of to a 100% that journald
# refuses to produce.
lab_root lab-api bash -c 'cat > /etc/systemd/journald.conf <<CONF
[Journal]
SystemMaxUse=120M
RateLimitIntervalSec=0
RateLimitBurst=0
CONF'
lab_root lab-api systemctl restart systemd-journald.service

lab_root lab-api bash -c \
  'head -c 105000000 /dev/urandom | base64 -w 40000 | systemd-cat -t dwara-flood'
lab_root lab-api journalctl --sync 2>/dev/null || true

ok "lab-api: the journal is now the largest thing in /var/log"
