#!/usr/bin/env bash
# Known-good fix for postgres-down: start Postgres.
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"
lab_root lab-db systemctl reset-failed postgresql@16-main.service 2>/dev/null || true
lab_root lab-db systemctl start postgresql@16-main.service
lab_root lab-db bash -c 'until pg_isready -q; do sleep 1; done'
