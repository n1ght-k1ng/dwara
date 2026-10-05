---
description: Show what Dwara has done on these hosts, and check the log has not been tampered with
argument-hint: [host] [--changes]
---

Show the Dwara audit log. $ARGUMENTS

Run `dwara audit` for the timeline, and `dwara audit verify` to check the hash
chain end to end.

The log records every call, including the ones that were refused — a log that
only recorded successes would describe an agent that never hit a limit.

Reading it:

- `verified` means the change was made **and its postconditions held**.
  `ok` only means a command exited zero, which is a weaker claim.
- `rolled_back` means it was made, did not work, and was undone.
- `refused` means it never reached the host.
- An `approval` id ties a change to the human decision that permitted it. The
  refusal and the action that followed carry the same id.

If `dwara audit verify` reports the chain is broken, say so prominently and stop.
Every entry after the first problem is suspect.
