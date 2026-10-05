# Dwara — Threat Model

**Status: partial.** This document is started in Phase 4 and finished in Phase 6. What
is here now is the adversarial review of one question, the one `docs/PLAN.md` asks for
before approvals ship: **can the agent approve its own action?** Assets, trust
boundaries and the other attacker models arrive in Phase 6.

## The premise

The model is untrusted. Not "probably fine" — untrusted, in the same sense as a user
submitting a form. It may be prompt-injected by a log line, a config comment, or an
HTTP response from a service it was asked to diagnose. Every guarantee below has to
hold when the model is actively trying to break it, and none of them may rest on the
model's good behaviour or on what a tool description asks it to do.

## Can the agent approve its own action?

`CLAUDE.md` rule 5 says no. Below is every route found, what stops it, and the test
that pins it. A row without a test is a claim, not a control.

| # | Route | What stops it | Pinned by |
|---|---|---|---|
| 1 | Call an approval tool over MCP | No such tool is registered. The MCP server advertises the registry, and the registry holds no tool that touches approvals. | `rule5.test.ts` · "a tool never touches the approval machinery at all" |
| 2 | Write the approval file from inside a tool | A tool is handed exactly one capability: `Ctx.run`, which executes argv **on a remote host**. There is no local filesystem handle anywhere in `Ctx`. | `rule5.test.ts` · "a tool is handed one capability, and it points at a remote host" |
| 3 | Import `grantApproval` from tool code | Granting lives in `approval/grant.ts`, which neither `@dwara/tools` nor `@dwara/mcp-server` imports. | `rule5.test.ts` · "%s does not reference the granting module" |
| 4 | Forge a plan hash | The hash is SHA-256 over the canonicalised tool, host and **every** argument. Producing one for an action a human did not see means finding a collision. | `approval.test.ts` · "changes when anything about the action changes" |
| 5 | Get approval for a harmless plan, then apply a different one | Same hash. One changed character is a different plan and is refused. | `pipeline.test.ts` · "refuses when the agent changes the plan after asking" |
| 6 | Reuse an approval for a second action | Single use. Claimed before the action runs, and the claim is an exclusive file create. | `approval.test.ts` · "stays spent once claimed" |
| 7 | **Spend one approval twice, in parallel** | **This worked.** See below. | `approval.test.ts` · "cannot be claimed twice, even by callers racing for it" |
| 8 | Sit on an approval and use it later | Fifteen minutes by default, checked at claim time. | `approval.test.ts` · "will not find an expired approval" |
| 9 | Edit `.dwara/policy.yaml` to drop `require_approval` | It is a local file; see row 2. No tool can write locally. | row 2 |
| 10 | Edit the policy on a managed host | The policy that governs an action is the one on the operator's machine, loaded at startup. A copy on a host governs nothing. | — (design, not code) |
| 11 | Read the approvals directory over SSH to forge a matching file | Approvals are local. A managed host has no copy to read or write. | — (design, not code) |
| 12 | Use a `destructive` tool, or one on the `never` list | Refused in the evaluator before host rules or overrides are consulted, so no policy edit could enable it even if one were possible. | `evaluate.test.ts` · destructive floor cases |
| 13 | Run the change over raw SSH instead, skipping Dwara | The PreToolUse hook, with a 67-case corpus and zero false negatives. **Defence in depth, not a boundary** — see the limitations. | `detect.test.ts` · the whole corpus |
| 14 | Persuade the human to approve something harmful | Nothing technical stops this, and nothing should: it is a person's decision. What Dwara owes them is an honest prompt — the full arguments, and whether the request writes anything. | `approve.test.ts` · "says a preview is only a preview" |

### Row 7 — the one that worked

The review found a real double-spend. The pipeline called `find(planHash)` and then
`consume(id)` as two steps, and between them was a window. Two concurrent calls both
found the same unused approval and both proceeded. This was not theoretical: **Claude
Code issues tool calls in parallel**, so an agent could ask for one approval, receive
it, and then fire the same action twice.

The damage was bounded — both calls carry the same plan hash, so both do the thing the
human approved, just twice — but "an approval is good for exactly one action" was a
claim Dwara made and could not keep. For `edit_config` that is two writes; for
`restart_service`, two restarts of a production service.

Fixed by replacing the two steps with a single `claim(planHash)`. The claim is an
**exclusive file create** (`writeFile` with flag `wx`), which the filesystem makes
indivisible: the second caller gets `EEXIST` and is refused. There is no longer a
method on `ApprovalStore` that can be used the unsafe way, which matters more than the
fix itself — the previous interface made the wrong thing easy and the right thing
require care.

## Known limitations, stated plainly

- **The hook is not a sandbox.** It reads a command and decides. An agent that writes
  a script and runs it defeats it, and so does any route that hides the destination
  behind something unparseable — the hook refuses those when it can tell they might
  reach a managed host, but it cannot tell about `bash ./deploy.sh`. The guarantee
  that does not depend on parsing anything is the **dedicated-key setup**: the agent's
  own shell holds no credentials for managed hosts, and only Dwara's key does. That is
  documented in Phase 6 and is the thing to rely on.
- **A managed host that is the operator's own machine collapses the boundary.** If
  `localhost` were managed, a remote write could in principle reach local Dwara state.
  Nothing currently permits it — `edit_config`'s allow-list covers service
  configuration under `/etc`, not `.dwara/` — but the separation is the reason it
  holds, and it is worth stating.
- **An approval is as good as the human reading it.** Dwara shows the tool, the host,
  every argument, whether the request writes anything, and that approving authorises
  exactly that action once. It cannot make anyone read it.
- **`restorable: false` tools cannot be undone.** `rotate_logs` and `prune_images`
  delete things. They are classed `reversible` because of the kind of change they make,
  not because the data comes back, and the pipeline says so rather than claiming a
  rollback it did not perform.
