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
# also the realistic version of this outage: somebody lifted the cap.
# Rate limiting is turned off for the same reason -- journald would otherwise
# throttle the flood and the break would quietly not happen.
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

log "breaking lab-api: lifting the journal cap and filling it"

lab_root lab-api bash -c 'cat > /etc/systemd/journald.conf <<CONF
[Journal]
SystemMaxUse=100M
RateLimitIntervalSec=0
RateLimitBurst=0
CONF'
lab_root lab-api systemctl restart systemd-journald.service

# ~100 MB of journal in one writer. base64 so every line is distinct and nothing
# is deduplicated or compressed away to nothing.
lab_root lab-api bash -c \
  'head -c 75000000 /dev/urandom | base64 | systemd-cat -t dwara-flood' || true
lab_root lab-api journalctl --sync 2>/dev/null || true

ok "lab-api: the journal is now the largest thing in /var/log"
