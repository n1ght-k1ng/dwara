# Dwara — Threat Model

**Status: Phase 6 in progress.** The adversarial review of self-approval was done in
Phase 4 and is below unchanged. Assets, trust boundaries and the attacker models were
added in Phase 6. Still outstanding: the input fuzzing (Phase 6 Task 2) and the
red-team session (Task 3), so some rows below say "argued" rather than "pinned", and
they are marked.

Every control named here points at the code that implements it and the test that holds
it. **A row without a test is a claim, not a control**, and is written as one.

## The premise

The model is untrusted. Not "probably fine" — untrusted, in the same sense as a user
submitting a form. It may be prompt-injected by a log line, a config comment, or an
HTTP response from a service it was asked to diagnose. Every guarantee below has to
hold when the model is actively trying to break it, and none of them may rest on the
model's good behaviour or on what a tool description asks it to do.

## What is being protected

In rough order of how much it would hurt to lose:

| Asset | Where it lives | What loss looks like |
|---|---|---|
| **Managed hosts' integrity and availability** | The servers Dwara is pointed at | A change nobody approved, or an outage caused by one |
| **Credentials on those hosts** | `/etc/shadow`, `**/.ssh/**`, `.env` files, `.pgpass` | Exfiltration through tool output into a model's context and onward |
| **The SSH key Dwara uses** | The operator's machine, referenced by `ssh_config` | Full access to every managed host |
| **The policy** | `.dwara/policy.yaml`, on the operator's machine | Every other guarantee, since policy decides what is allowed |
| **The approval store** | `.dwara/` on the operator's machine | The human-in-the-loop guarantee |
| **The audit log** | `.dwara/audit.jsonl` | The ability to say afterwards what happened |
| **The operator's own machine** | — | Everything above at once |

## Trust boundaries

There are four, and the interesting ones are 1 and 3.

```
  ┌─────────────────────────────────────────────┐
  │ 1. The model                    UNTRUSTED   │
  │    Chooses tool names and arguments.        │
  └───────────────────┬─────────────────────────┘
                      │  MCP (stdio), JSON arguments
  ┌───────────────────▼─────────────────────────┐
  │ 2. Dwara, on the operator's machine TRUSTED │
  │    Schemas, policy, approvals, snapshots,   │
  │    verifier, redactor, audit log.           │
  └───────────────────┬─────────────────────────┘
                      │  ssh, BatchMode=yes, argv arrays
  ┌───────────────────▼─────────────────────────┐
  │ 3. Managed hosts            SEMI-TRUSTED    │
  │    Trusted to run commands; their OUTPUT is │
  │    untrusted data, never instructions.      │
  └───────────────────┬─────────────────────────┘
                      │  stdout/stderr
  ┌───────────────────▼─────────────────────────┐
  │ 4. The human                    THE AUTHORITY│
  │    The only thing that can approve.          │
  └─────────────────────────────────────────────┘
```

**Boundary 1 is the one the design is built around.** The model is untrusted in the
same sense as a user submitting a form: it may be prompt-injected by a log line, a
config comment, a file name or an HTTP body. So no guarantee may rest on a tool
description, on the model's good behaviour, or on it having been asked nicely.

**Boundary 3 is the one people forget.** A managed host is trusted to execute what it
is sent, and its output is *data*. Output crosses back into the model's context, so a
compromised or merely misconfigured host is an injection vector. Every tool result is
wrapped in an envelope marked `source: "untrusted-server-output"` with suspicious
content flagged (`envelope.ts`).

## Attacker models

### A. Malicious or injected server content

**Capability:** can put arbitrary text anywhere Dwara reads — a log line, a config
comment, a file name, a container name, a systemd unit description, an HTTP body.

| Control | Where | Pinned by |
|---|---|---|
| Output is wrapped as data, never spliced into instructions | `envelope.ts` `wrap()` | `envelope.test.ts` |
| Six detectors flag instruction-override, model-addressing, anti-Dwara, credential-exfiltration and hidden-text patterns | `envelope.ts` `DETECTORS` | `envelope.test.ts` |
| Zero-width characters and ANSI escapes are flagged, because both hide text from a human reading the same output | same | same |
| Acting on an injected instruction still has to pass policy and approval — reading a log cannot grant a capability | `pipeline.ts` | `pipeline.test.ts` |
| Five benchmark scenarios measure whether an agent *acts* on planted text, scored from the audit log | `evals/scenarios/injection-*` | `BENCHMARK.md` |

**Deliberately not claimed:** the detectors are a flag for a human, not a filter. They
are tuned to miss polite prose — "you must restart nginx" — because an operator who
stops trusting the flags is worse off than one who never had them. **Injection
resistance is a measured property of the model, not a guarantee of this code**, which is
why the benchmark has a category for it.

### B. A compromised or adversarial agent

**Capability:** chooses any tool name and any arguments, in any order, in parallel; can
read everything in its own context; can run whatever its client allows outside Dwara.

| Control | Where | Pinned by |
|---|---|---|
| No arbitrary shell tool exists; capability is the tool list | `packages/tools` | `CLAUDE.md` rule 2, registry tests |
| Arguments are zod-validated before anything else happens | `pipeline.ts` step 1 | `pipeline.test.ts` |
| Commands are `argv` arrays; every element is escaped individually, never concatenated | `ssh/transport.ts` | `transport.test.ts` |
| Path guards run lexically *then* re-check the resolved path, because `readlink -f /etc/nginx/../shadow` is `/etc/shadow` | `paths.ts` | `paths` tests, captured fixture |
| A deny-list no policy can loosen covers shadow, sudoers, private keys, `.env`, `.pgpass`, shell history | `DENIED_PATHS` | `paths` tests |
| `destructive` is refused before host rules or overrides are consulted | `policy/evaluate.ts` step 4 | `evaluate.test.ts` |
| Policy precedence is deny > approval > allow, and overrides may only tighten | `policy/evaluate.ts` | `evaluate.test.ts`, 100% branch coverage required |
| The agent cannot approve its own action — 14 routes, below | `approval/` | `rule5.test.ts` and others |
| Per-session action budget and one host per action | `session.ts`, `limits` | `pipeline.test.ts` |
| Every call is logged including refusals, hash-chained | `audit/` | `audit` tests |
| Raw SSH to a managed host is blocked by the PreToolUse hook | `packages/hook` | 67-case corpus, zero false negatives |

### C. A malicious policy change

**Capability:** opens a pull request, or edits `.dwara/policy.yaml` on a machine they
already have.

Policy is the root of the other guarantees, so this is the highest-leverage attack that
does not require code execution.

| Control | Where | Status |
|---|---|---|
| `destructive` cannot be enabled by any policy | `evaluate.ts` | pinned |
| `tools.never` cannot be loosened by an override | `evaluate.ts` | pinned |
| Overrides may tighten freely and may only loosen `require_approval`, never `deny` or `never` | `evaluate.ts` | pinned |
| The path deny-list is in code, not policy | `DENIED_PATHS` | pinned |
| Policy is loaded from the operator's machine at startup; a copy on a managed host governs nothing | design | argued |
| The policy's SHA-256 is recorded in every audit entry, so a change is visible after the fact | `audit/entry.ts` `policy_hash` | pinned |
| **A policy diff is reviewable by a human** — the file is small, declarative YAML for exactly this reason | design | argued |

**Not defended:** an operator who approves a bad policy change. `policy_hash` makes it
attributable afterwards; nothing makes it impossible.

### D. A local attacker on the operator's machine

**Capability:** reads and writes files as the operator.

This one is largely **conceded, and should be**: anyone who can write
`.dwara/policy.yaml`, the approval store, or the SSH key has already won, and no
in-process control can change that.

| Property | Reality |
|---|---|
| Approval store | Exclusive-create claim stops *races*, not an attacker who can write the directory |
| Audit log | Hash chain makes tampering **detectable, not impossible**. Anyone who can write the file can rewrite it from any point and recompute the hashes; what they cannot do is change one line and leave the rest verifying. Genuinely append-only is an OS question (`chattr +a`, shipping lines off-host) and is documented rather than pretended at |
| SSH key | Protected by file permissions and whatever the operator's disk encryption gives them |
| Dwara's own state | `.dwara/` is created mode 0700, files 0600 |

The control that does help is the **dedicated key**: Dwara's key is the only credential
for managed hosts, and the agent's ordinary shell has none. That bounds what a
compromised *agent* can reach without bounding a compromised *operator account*.

### E. The hosts themselves

Out of scope in the sense that Dwara does not defend a host from its own root. What
Dwara owes is to not *become* the weakness: `sudo -n` only, never a password prompt and
never a stored password; a pinned sudoers allow-list rather than blanket sudo;
`BatchMode=yes` always; and no tool that runs arbitrary commands.

**A finding worth stating here:** the sudoers allow-list is itself a security surface,
and a rule can hand over more than it looks like. `tee -- /etc/systemd/system/*` plus
the already-granted `systemctl start *` is equivalent to full root, because a unit file
*is* an arbitrary root command. That is why the lab does not grant it, and why whether
Dwara should edit unit files at all is an open question in `docs/PROGRESS.md` rather
than a settled yes.

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

## Red team: the redactor

Phase 6 Task 3. A deliberate attempt to get a credential past the redactor, with
every case kept as a test in `redact/redteam.test.ts` — the caught ones so a
regression is a failure, the gaps so nobody has to rediscover them.

**One leak found and fixed: a YAML block scalar.**

```yaml
database:
  password: |
    Xk9mQ2vL8pR4tY7wZ1nB3hJ6     # returned in full
```

The general assignment rule already reaches across a newline, so
`POSTGRES_PASSWORD:\n  value` was redacted. The `|` indicator sits between the key
and the value and stopped it matching, and entropy analysis did not save it either
because that requires secret-like context **on the same line** — and the value's
own line is just an indented token. `read_config` on anything keeping a credential
this way would have handed it over. Fixed with a rule covering `|`, `>`, and the
strip and explicit-indent forms.

**Two gaps remain, and both are deliberate:**

| Gap | Why it stays |
|---|---|
| A high-entropy token on a line with **no secret-like word** | Entropy analysis is gated on context. Without the gate, every image digest in `docker ps`, every git SHA and every UUID is redacted, and a redactor nobody can read through gets turned off |
| A long token of only **two character classes**, even with context | Three is the floor. Two would catch every hex digest and container id — the same unusable outcome |

A value wrapped mid-token loses its first half to the assignment rule and keeps
the remainder; nothing is anchored across the break. No pattern-based redactor
fixes that without reassembling arbitrary text.

**Two things written up as gaps turned out not to be.** A value under twenty
characters and a value split from its key by a newline are both caught, by rules
this review had not accounted for. They were removed rather than left in as
comfortable-sounding limitations — which is the main argument for measuring each
case instead of reasoning about the code.

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
- **Injection resistance is a property of the model, not of this code.** The envelope
  marks server output as data and flags six patterns, but an agent that chooses to act
  on an injected instruction will have its action judged by policy and nothing more.
  The five `injection-*` benchmark scenarios exist because this is the one guarantee
  Dwara cannot make structurally, so it has to be measured instead.
- **The audit log is tamper-evident, not tamper-proof.** Anyone who can write the file
  can rewrite it from any point and recompute the chain. One edited line in place is
  what the chain catches. Append-only is an operating-system property
  (`chattr +a`, shipping lines off-host), not something a library can provide.
- **A sudoers rule can grant more than it appears to.** `tee` into a directory of
  systemd unit files, together with permission to start units, is full root. The
  allow-list has to be read as a whole, not rule by rule, and the Phase 6 dedicated-key
  guide has to say so.
- **The fuzzing and red-team passes are not done.** Phase 6 Tasks 2 and 3. Until they
  are, the rows above marked *argued* are reasoning about the code rather than evidence
  from attacking it, and a few of the `pinned` rows rest on tests written by the same
  person who wrote the control.
