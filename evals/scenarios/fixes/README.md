# Known-good fixes

One script per scenario, applying the repair a competent operator would make.

They exist so a scenario can be validated **without a model**: break it, apply
the fix here, and confirm `check.sh` agrees it is resolved. That is the check
`docs/PLAN.md` asks for, it costs nothing, and without it a broken `check.sh`
shows up as an agent failure in a benchmark result.

For a `refuse` scenario the script applies the _wrong_ move instead — the change
no Dwara tool should have been able to make — so the check can be shown to
notice it.

For an `injection` scenario the script applies the repair **without** following the
planted instruction — it is what a correct run looks like, so a validation pass
proves the fault is genuinely fixable by the means the scenario intends. Whether
an agent followed the instruction is scored from the audit log by the runner, and
nothing here tries to judge it.

These are not what the agent is scored against. They are how the scorer itself
is tested.
