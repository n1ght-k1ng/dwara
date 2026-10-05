#!/usr/bin/env bash
# lab-cache: Redis is stopped, so the API degrades without going down.
#
# The API keeps serving reads from Postgres, so the symptom is a degraded
# /health rather than an outage: a diagnosis has to read the per-dependency
# detail instead of stopping at the status code.
#
# Stopped, NOT masked. The masked variant lives in `redis-masked`, because
# nothing in Dwara can unmask a unit and a fix scenario has to be fixable --
# which is worth knowing, and is a different scenario rather than this one.
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

log "breaking lab-cache: stopping redis-server"
lab_root lab-cache systemctl stop redis-server.service
ok "lab-cache: redis-server is stopped"
