#!/usr/bin/env bash
# Known-good fix for journal-full: vacuum the journal down to 32MB.
#
# What rotate_logs does in journal mode. Truncating files under /var/log/journal
# by hand would corrupt it, which is why the tool has a separate mode at all.
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"
lab_root lab-api journalctl --vacuum-size=32M >/dev/null 2>&1 || true
