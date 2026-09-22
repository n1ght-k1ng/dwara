#!/usr/bin/env bash
# Generate the lab-only SSH keypair used by every testbed host.
# The keypair lives in testbed/.keys/, which is gitignored and never published.

source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

mkdir -p "$KEY_DIR"
chmod 700 "$KEY_DIR"

if [ -f "$KEY_FILE" ]; then
  log "lab key already present at ${KEY_FILE#"$REPO_ROOT"/}"
else
  log "generating lab SSH keypair"
  ssh-keygen -t ed25519 -N '' -C 'dwara-lab (testbed only)' -f "$KEY_FILE" >/dev/null
  ok "created ${KEY_FILE#"$REPO_ROOT"/}"
fi

chmod 600 "$KEY_FILE"
chmod 644 "$KEY_FILE.pub"
touch "$KEY_DIR/known_hosts"
