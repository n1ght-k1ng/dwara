#!/usr/bin/env bash
# lab-db: Postgres is stopped, and lab-api fails rather than degrades.
#
# The database is the dependency the API cannot do without, so unlike redis-down
# this one is a visible outage: /health returns 503 and the symptom host is not
# the broken host.
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

log "breaking lab-db: stopping Postgres"
lab_root lab-db systemctl stop postgresql@16-main.service
ok "lab-db: postgresql@16-main is stopped"
