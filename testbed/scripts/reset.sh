#!/usr/bin/env bash
# Return the testbed to a known-good baseline.
#
# This is a full recreate rather than an in-place repair: the benchmark in
# Phase 5 needs every scenario to start from an identical state, and a break
# script is allowed to leave a host in any condition at all.

source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

require_docker

log "resetting the testbed to baseline"
"$TESTBED_DIR/scripts/down.sh" --volumes
"$TESTBED_DIR/scripts/up.sh"
