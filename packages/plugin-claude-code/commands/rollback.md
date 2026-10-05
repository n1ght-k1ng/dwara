---
description: Put a host back to a snapshot Dwara took before an earlier change
argument-hint: <snapshot-id> [host]
---

Roll back `$1`. $ARGUMENTS

You do not need this for a change that failed its own verification — those are
undone automatically and the result says so. Use it when a change verified at the
time and turned out to be wrong afterwards.

1. Find the snapshot if you were not given one. The id is in the result of the
   change that created it, and in the audit log.
2. `config_rollback` restores the files and checks every one against the hash
   recorded when the snapshot was taken.
3. Read the result. If `stateConfirmed` is false, the files are back but a
   service has not re-read them — restart or reload it, then check again.

This needs a human to approve it, like any config change.

If the result says files did not come back as recorded, stop. That host needs a
person, and saying so is more useful than another attempt.
