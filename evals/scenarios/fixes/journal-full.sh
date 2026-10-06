#!/usr/bin/env bash
# Known-good fix for journal-full: shrink the journal.
#
# Exactly what rotate_logs does in journal mode -- `--vacuum-size` and nothing
# else -- so a validation pass proves the scenario is fixable by the means the
# agent actually has, rather than by a better one.
#
# `--rotate` first is deliberately NOT done here, even though it would be the
# more thorough move: `--vacuum-size` only removes *archived* journal files, so
# the worry was that a large active file would be untouchable. Measured from the
# real broken state it is not an issue -- journald had already rotated the flood
# into archives, and vacuum alone went 125MB to 16MB. If rotate_logs ever needs
# `--rotate`, this script must not be the thing hiding it.
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

echo "journal before: $(lab_root lab-api du -sm /var/log/journal | cut -f1)MB"
lab_root lab-api journalctl --vacuum-size=32M
echo "journal after:  $(lab_root lab-api du -sm /var/log/journal | cut -f1)MB"
