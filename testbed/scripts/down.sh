#!/usr/bin/env bash
# Stop the testbed. Pass --volumes to discard lab state as well.

source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

require_docker

if [ "${1:-}" = "--volumes" ]; then
  log "stopping lab hosts and removing volumes"
  compose down --volumes --remove-orphans
else
  log "stopping lab hosts"
  compose down --remove-orphans
fi
ok "testbed is down"
