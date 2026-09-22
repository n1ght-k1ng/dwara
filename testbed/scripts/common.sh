#!/usr/bin/env bash
# Shared helpers for the Dwara testbed scripts.
#
# Every script sources this and runs from the repo root, because testbed/ssh_config
# refers to the lab key by a repo-relative path.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

TESTBED_DIR="$REPO_ROOT/testbed"
KEY_DIR="$TESTBED_DIR/.keys"
KEY_FILE="$KEY_DIR/dwara_lab"
SSH_CONFIG="$TESTBED_DIR/ssh_config"
COMPOSE_FILE="$TESTBED_DIR/compose.yaml"

LAB_HOSTS=(lab-api lab-db lab-cache lab-queue lab-staging)

if [ -t 1 ]; then
  C_RED=$'\033[31m'; C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'; C_DIM=$'\033[2m'; C_OFF=$'\033[0m'
else
  C_RED=''; C_GREEN=''; C_YELLOW=''; C_DIM=''; C_OFF=''
fi

log()  { printf '%s==>%s %s\n' "$C_DIM" "$C_OFF" "$*"; }
ok()   { printf '%s  ok%s  %s\n' "$C_GREEN" "$C_OFF" "$*"; }
warn() { printf '%swarn%s  %s\n' "$C_YELLOW" "$C_OFF" "$*"; }
die()  { printf '%sfail%s  %s\n' "$C_RED" "$C_OFF" "$*" >&2; exit 1; }

require_docker() {
  command -v docker >/dev/null 2>&1 || die "docker not found on PATH"
  docker info >/dev/null 2>&1 || die "cannot reach the Docker daemon (is Docker Desktop running?)"
  docker compose version >/dev/null 2>&1 || die "docker compose v2 is required"
}

compose() {
  docker compose -f "$COMPOSE_FILE" --project-name dwara-lab "$@"
}

# Public key is passed to the image build; the private key never leaves the host.
export_pubkey() {
  [ -f "$KEY_FILE.pub" ] || die "lab key missing; run testbed/scripts/gen-keys.sh"
  DWARA_LAB_PUBKEY="$(cat "$KEY_FILE.pub")"
  export DWARA_LAB_PUBKEY
}

lab_ssh() {
  local host="$1"; shift
  ssh -F "$SSH_CONFIG" "$host" "$@"
}

# Retry a command until it succeeds or the deadline passes.
wait_for() {
  local desc="$1" timeout="$2"; shift 2
  local deadline=$(( SECONDS + timeout ))
  until "$@" >/dev/null 2>&1; do
    if [ "$SECONDS" -ge "$deadline" ]; then
      return 1
    fi
    sleep 2
  done
  printf '%s  ok%s  %s\n' "$C_GREEN" "$C_OFF" "$desc"
}
