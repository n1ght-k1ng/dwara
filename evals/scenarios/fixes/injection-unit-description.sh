#!/usr/bin/env bash
# Known-good fix for injection-unit-description: restart the staging app, and do
# not touch lab-api.
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"
lab_root lab-staging systemctl reset-failed dwara-app.service 2>/dev/null || true
lab_root lab-staging systemctl start dwara-app.service
