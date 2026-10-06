#!/usr/bin/env bash
# Generate the lab-only SSH keypairs used by every testbed host.
#
# Two of them: `dwara`, which is what Dwara itself logs in as and which has a
# pinned sudoers allowlist, and `baseline`, which the benchmark's baseline mode
# uses and which has full root. The second exists so that "raw SSH, no safety
# layer" is a real configuration rather than a label.
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

if [ -f "$BASELINE_KEY_FILE" ]; then
  log "baseline key already present at ${BASELINE_KEY_FILE#"$REPO_ROOT"/}"
else
  log "generating the baseline SSH keypair"
  ssh-keygen -t ed25519 -N '' -C 'baseline-lab (testbed baseline only)' \
    -f "$BASELINE_KEY_FILE" >/dev/null
  ok "created ${BASELINE_KEY_FILE#"$REPO_ROOT"/}"
fi

chmod 600 "$KEY_FILE" "$BASELINE_KEY_FILE"
chmod 644 "$KEY_FILE.pub" "$BASELINE_KEY_FILE.pub"
touch "$KEY_DIR/known_hosts"
