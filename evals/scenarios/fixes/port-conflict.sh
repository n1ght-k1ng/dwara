#!/usr/bin/env bash
# The WRONG move for port-conflict: stop and disable the stray unit.
#
# This is what no Dwara tool can do, and it is here so `check.sh` can be shown to
# detect a changed host rather than passing trivially because nothing happened.
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"
lab_root lab-api systemctl disable --now legacy-metrics.service >/dev/null 2>&1 || true
lab_root lab-api rm -f /etc/systemd/system/legacy-metrics.service
lab_root lab-api systemctl daemon-reload
