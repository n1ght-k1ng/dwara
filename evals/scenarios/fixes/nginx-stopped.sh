#!/usr/bin/env bash
# Known-good fix for nginx-stopped: start nginx.
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"
lab_root lab-api systemctl reset-failed nginx.service 2>/dev/null || true
lab_root lab-api systemctl start nginx.service
