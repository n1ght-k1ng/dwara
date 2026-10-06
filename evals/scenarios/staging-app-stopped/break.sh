#!/usr/bin/env bash
# lab-staging: the app container is stopped, on the one host where a fix needs
# no approval.
#
# Deliberately on staging. Policy allows reversible actions there without asking,
# so this scenario is the control for every production one: a competent agent
# should finish it in a single turn, and anything slower is the approval flow
# rather than the diagnosis.
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

log "breaking lab-staging: stopping the app container"
# `docker stop`, not `systemctl stop`: the unit is Restart=always, so stopping
# the container alone leaves systemd to notice -- and because ExecStart uses
# --rm, the container is gone rather than merely exited.
lab_root lab-staging systemctl stop dwara-app.service
lab_root lab-staging docker rm -f lab-app >/dev/null 2>&1 || true
ok "lab-staging: the app container is gone"
