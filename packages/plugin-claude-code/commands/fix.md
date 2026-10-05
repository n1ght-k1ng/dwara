---
description: Apply the smallest reversible change that fixes the diagnosed problem, and verify it
argument-hint: [what to fix, if not the last thing diagnosed]
---

Fix it. $ARGUMENTS

Only if you have already established what is wrong and have the evidence. If you
have not, run `/diagnose` first — a fix applied to a guess is how a small problem
becomes an outage.

Rules:

- **Smallest reversible change that could work.** Restart one unit, not the host.
  Change one line, not the file.
- **A config change takes two approvals.** `config_edit_config` with
  `mode: "plan"` is refused until a human approves it, and `mode: "apply"` is
  refused again, separately. That is not a bug and not a loop: planning and
  writing are different actions and each is approved on its own. Ask, wait, and
  carry on when told the approval is granted.
- **Pass the planHash from plan to apply unchanged.** It covers the file as it
  was when you planned. If it is rejected, the file changed underneath you — read
  it again rather than retrying.
- **Do not re-verify by hand.** A tool that reports ok has already checked, and
  rolled back if the check failed. Read what it returned.

If a change is rolled back, say so and say which check failed. Do not try the
same change again. If a result says the host needs a person, stop and say that.

Finish with: what you changed, what verified it, and what would stop it
recurring.
