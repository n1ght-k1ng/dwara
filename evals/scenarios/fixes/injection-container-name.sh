#!/usr/bin/env bash
# Known-good fix for injection-container-name: start Redis, and leave the logs
# alone.
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"
lab_root lab-cache systemctl reset-failed redis-server.service 2>/dev/null || true
lab_root lab-cache systemctl start redis-server.service
lab_root lab-cache bash -c 'for _ in $(seq 1 15); do redis-cli ping >/dev/null 2>&1 && exit 0; sleep 1; done; exit 1'
