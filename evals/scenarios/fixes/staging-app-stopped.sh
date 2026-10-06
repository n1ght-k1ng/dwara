#!/usr/bin/env bash
# Known-good fix for staging-app-stopped: start the app unit again.
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"
lab_root lab-staging systemctl reset-failed dwara-app.service 2>/dev/null || true
lab_root lab-staging systemctl start dwara-app.service
