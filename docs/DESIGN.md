# Dwara — Design

## 1. Scope

**MVP:** give any MCP-capable coding agent safe, policy-controlled access to Linux servers over SSH, with typed
tools, snapshots, verification, rollback, and an audit trail. Deepest integration with Claude Code.

**Non-goals (MVP):** always-on daemon, alerts, web dashboard, hosted service, Kubernetes, non-systemd distros,
Windows servers, multi-user approvals, destructive tools.

## 2. High-level architecture

```
Developer machine                                          Servers
┌───────────────────────────────────────────────┐
│ Coding agent (Claude Code, Codex, Cursor, …)  │
│   │ MCP (stdio)             │ Bash tool       │
│   ▼                         ▼                 │
│ ┌─────────────┐      ┌──────────────┐         │
│ │ MCP server  │      │ PreToolUse   │ blocks  │
│ └─────┬───────┘      │ hook         │ raw ssh │
│       ▼              └──────────────┘         │
│ ┌──────────────── Core ──────────────────┐    │
│ │ Registry → Policy → Snapshot → Execute │    │
│ │ → Verify → Redact → Audit              │    │
│ └─────────────────┬──────────────────────┘    │
│                   ▼                           │
│      SSH transport (system ssh, ControlMaster)│── SSH ──▶ hosts
│ CLI: init · doctor · approve · audit ·        │
│      rollback · eval                          │
│ .dwara/: policy.yaml · runbooks/ · audit     │
└───────────────────────────────────────────────┘
```

| Component | Responsibility |
|---|---|
| CLI | init, doctor, approve, audit, rollback, eval |
| MCP server | Thin stdio adapter exposing registry tools and runbook resources |
| Tool registry | Tool definitions: schema, risk, command builder, parser, snapshot, verify, rollback |
| Policy engine | allow / approval / deny per host and risk; independent of the model |
| SSH transport | Runs argv via system `ssh`; reuses user config, keys, agents, jump hosts |
| Snapshot manager | Server-side backups before any change |
| Verifier | Postcondition checks; triggers auto-rollback |
| Redactor | Removes secrets from all output |
| Audit logger | Append-only, hash-chained JSONL |
| Hook | Blocks raw SSH to managed hosts from the agent's Bash tool |
| Plugin | Claude Code commands, skill, hook config, permission settings |
| Eval harness | Dockerized scenarios, headless agent runs, scoring |

## 3. Tool call pipeline

1. Validate input with zod.
2. Resolve host against SSH config and policy (unknown host → deny).
3. Policy decision: allow / approval / deny.
4. If approval required: return plan + plan hash + approval ID; stop.
5. Snapshot if the tool mutates state.
6. Execute argv commands with timeout and output cap.
7. Verify postconditions; on failure restore snapshot and report.
8. Parse, redact, wrap in untrusted-data envelope.
9. Write audit entry; return result.

## 4. Security model

- The model is untrusted and may be prompt-injected. Safety lives in code only.
- Server output is untrusted data: redacted, truncated, wrapped, flagged if suspicious.
- The agent can never approve its own action.
- No arbitrary shell tool. All remote commands are templated argv arrays, escaped per element.
- Destructive risk class is denied in MVP.
- The hook is defense in depth, not a sandbox. The strong guarantee is the dedicated-key setup: the agent's normal
  shell has no credentials for managed hosts; only Dwara does.

## 5. Core types

```ts
export enum Risk { Read = "read", Reversible = "reversible", Config = "config", Destructive = "destructive" }

export interface RemoteCommand {
  argv: string[];        // each element escaped individually
  sudo?: boolean;        // sudo -n only
  timeoutMs: number;
}

export interface ToolDef<I, O> {
  name: string;
  description: string;   // for the model: when to use, what it returns, what to check next
  risk: Risk;
  input: z.ZodType<I>;   // always includes `host`
  build(input: I): RemoteCommand[];
  parse(raw: RawResult[]): O;
  snapshot?(input: I): SnapshotSpec;          // required for reversible/config
  verify?(input: I, ctx: Ctx): Promise<VerifyResult>;
  rollback?(snap: SnapshotRef): RemoteCommand[];
  maxOutputBytes?: number;
}

export type Decision =
  | { kind: "allow" }
  | { kind: "approval"; reason: string }
  | { kind: "deny"; reason: string };
```

## 6. Policy

```yaml
version: 1
defaults:
  allow: [read]
  require_approval: [reversible, config]
  deny: [destructive]
hosts:
  - match: "prod-*"
    tags: [production]
    require_approval: [reversible, config]
    health_checks:
      - http: "https://localhost/health"
        expect_status: 200
  - match: "staging-*"
    allow: [read, reversible]
    require_approval: [config]
tools:
  never: [delete_volume, drop_database]
  overrides:
    prune_images: { allow_on: ["*"] }
redaction:
  extra_patterns: []
limits:
  max_actions_per_session: 20
  max_hosts_per_action: 1
```

**Evaluation:**
1. Host not in SSH config or policy → deny.
2. Tool in `never` → deny.
3. Most specific host rule merged over defaults.
4. Precedence: deny > require_approval > allow.
5. Overrides applied; can never loosen `never` or `deny`.
6. Session limits checked.
7. Return decision + reason. Policy file hash recorded in every audit entry.

## 7. SSH transport

- `ssh [-F cfg] -o BatchMode=yes -o ControlMaster=auto -o ControlPath=~/.dwara/cm-%C -o ControlPersist=60s <host> -- <escaped argv>`
- Reject NUL and control characters in arguments.
- Default timeout 30s, output cap 64 KB, `truncated` flag.
- `sudo -n` only; on password requirement return a setup hint.

## 8. Tool catalog (MVP)

| Tool | Risk | Snapshot | Verify |
|---|---|---|---|
| host_overview | read | – | – |
| service_status | read | – | – |
| tail_logs (journal/file, time window, grep) | read | – | – |
| disk_usage (dirs + docker) | read | – | – |
| docker_ps, container_logs, container_inspect | read | – | – |
| open_ports, cert_expiry | read | – | – |
| read_config (allowlisted paths) | read | – | – |
| security_audit | read | – | – |
| restart_service, restart_container | reversible | state record | active/healthy and stable N s |
| prune_images, rotate_logs | reversible | removal list | space freed |
| edit_config (unified diff; plan + apply) | config | file copy | validator, then service healthy |
| rollback | config | – | restored hashes match |

MCP tool names are prefixed by risk (`read_*`, `reversible_*`, `config_*`) so client permission rules can match them.

## 9. Approval flow

1. **Client permission prompts** (Claude Code): plugin settings auto-allow `read_*`, prompt for others.
2. **Plan binding:** `config_*` tools first return a plan (diff, commands, validator, rollback) and plan hash
   without executing; apply requires the identical hash.
3. **CLI fallback:** `approval_required` with ID → user runs `dwara approve <id>` → short-lived approval bound to
   plan hash stored locally → agent retries.
4. No MCP tool can create or modify approvals.

## 10. Snapshots and rollback

- Server path: `/var/lib/dwara/snapshots/<id>/` with files, modes, owners, SHA-256, `meta.json`.
- Snapshot ID recorded in the local audit log.
- edit_config: snapshot → apply diff → validator → reload → verify; failure at any step → restore + reload.
- Retention: last 20 per host or 7 days.
- `dwara rollback <id>` works without the agent.

## 11. Verifier

- Service `active` and stable ≥ 10 s (catches crash loops).
- Container running; health check passing if defined.
- Optional HTTP checks from policy.
- Validator commands.
- Retries with backoff up to a timeout; structured result included in tool output.

## 12. Redactor

- Patterns: private key blocks, cloud keys, JWTs, bearer tokens, common API key formats, `password=`, URLs with
  credentials, connection strings.
- Entropy check for long random strings near secret-like keywords.
- Replace with `[REDACTED:<type>]`.
- Extra patterns from policy.
- Tested against a corpus (≥100 positives, ≥100 negatives).

## 13. Prompt-injection defenses

- Output envelope marks server content as untrusted data.
- Flag suspicious content (text addressing the AI, instructions to change security settings).
- Structural defense: typed tools, policy, denied destructive class, human approval for config.
- Benchmark includes injection scenarios.

## 14. Audit log

`.dwara/audit.jsonl`:
```json
{"ts":"…","session":"s_8f2","agent":"claude-code","tool":"config_edit_config","host":"lab-api",
 "risk":"config","decision":"approval","approved_by":"client_prompt","plan_hash":"…",
 "snapshot":"snap_1a9","result":"verified","duration_ms":4120,
 "policy_hash":"…","prev_hash":"…","hash":"…"}
```
`dwara audit` (timeline, filters) and `dwara audit verify` (chain integrity).

## 15. PreToolUse hook

- Reads hook JSON from stdin; only inspects Bash tool calls.
- Parses with shell-quote; detects ssh/scp/rsync/sftp/mosh to managed hosts, including inside `bash -c`, `eval`,
  `$(...)`, backticks, `xargs`, env prefixes, and scripts.
- Blocks with a message that names the Dwara tools to use.
- Fails closed when a command can't be parsed and mentions a managed host.
- Optional policy flag to allow raw SSH to non-production hosts.

## 16. Claude Code plugin

- Commands: `/diagnose <host>`, `/fix`, `/harden <host>`, `/rollback`, `/audit`.
- Skill: evidence first with read tools, consult runbooks, smallest reversible fix, verify, summarize with evidence.
- `hooks.json` registering the PreToolUse hook.
- Permission settings: `read_*` allowed, others prompt.
- Runbooks exposed as MCP resources.

## 17. `dwara init`

1. Parse `~/.ssh/config` (incl. `Include`); list hosts.
2. Select managed hosts; tag production.
3. Run doctor.
4. Write `.dwara/policy.yaml`; update `.gitignore`.
5. Register MCP server with Claude Code; print snippets for other agents.
6. Offer plugin install.
7. Print a suggested first prompt.

## 18. Eval harness

- Scenario: `compose.yaml`/overlay, `break.sh`, `prompt.txt`, `check.sh`, `meta.yaml`.
- 20 scenarios: 12 fix, 5 injection, 3 should-refuse.
- Runner: reset → break → headless agent run (`claude -p` with Dwara MCP config) → collect audit → check → score →
  reset. Baseline mode: raw SSH without Dwara.
- Metrics: resolution rate, unsafe attempts, injection success rate, correct refusals, tool calls, tokens, cost,
  time to resolution.

## 19. Testing strategy

- Unit: policy table tests, escaping property tests, redactor corpus, audit chain, hook parsing and evasion.
- Integration: every tool against the testbed (success, failure, timeout, rollback).
- Security: input fuzzing for injection, approval-bypass attempts, red-team sessions.
- CI: unit + lint + typecheck on PR; integration on PR with testbed; evals on demand.

## 20. Decisions

Record decisions here as `YYYY-MM-DD — decision — reason`.

2026-09-22 — **Policy merge is specificity-wins per risk class.** A risk class named anywhere in the winning
host rule takes its decision from that rule; `defaults` only fills classes no winning rule mentions.
Precedence (`deny > require_approval > allow`) applies only *within* one level. Reason: read literally,
section 6's steps 3 and 4 contradict each other, and the union reading makes this file's own `staging-*`
example a no-op — `allow: [read, reversible]` would lose to the inherited `require_approval: [reversible]`.

2026-09-22 — **Equally specific host rules merge strictest-first.** When two patterns tie on specificity
(`lab-*` and `*-api` for `lab-api`), every tied rule is considered and the most restrictive verdict per risk
class wins. Reason: order-independence. Under first-match-wins, reordering the policy file or inserting a
rule above another could quietly loosen it, and a policy file is reviewed as a diff.

2026-09-22 — **Host pattern specificity = exact beats wildcard, then literal character count.** Reason: it is
predictable from reading the file and needs no tie-breaking heuristics; genuine ties go to the rule above.

2026-09-22 — **`destructive` is denied in code, not in policy.** The evaluator refuses the class before
consulting host rules or overrides. Reason: `CLAUDE.md` rule 8 denies the class in the MVP, and a guarantee
that a policy file could lift is not a guarantee — including when that file is edited by a compromised agent
or an unreviewed PR.

2026-09-22 — **A risk class no rule mentions is denied.** Reason: fail closed. Silence in a security policy
is not permission.

2026-09-22 — **A policy refusal is reported ahead of an exhausted session budget.** Reason: the agent needs
to learn that an action is not permitted at all, rather than concluding it merely ran out of turns and
should retry in a new session.

2026-09-22 — **Argv escaping is POSIX single-quoting, not `shell-quote`'s `quote()`.** Reason: `quote()`
targets an interactive bash and emits `\!` inside double quotes to defeat history expansion. A
non-interactive shell — which is what `ssh host cmd` runs — does not treat that as an escape, so any argument
containing `!` arrives with a literal backslash. Reproduced on `/bin/sh` and `/bin/bash`; found by the
property test. `shell-quote` remains the right tool for *parsing* commands in the PreToolUse hook (§15).

2026-09-22 — **Arguments containing NUL, C0 controls or DEL are rejected, not escaped.** Reason: they are
invisible in the logs, diffs and audit entries a human reads afterwards to work out what ran, and nothing
legitimate needs them — content with newlines goes over stdin.

2026-09-22 — **The transport enforces its own timeout rather than using execa's.** Reason: execa kills the
client and then waits for its stdio to close, but the persistent ControlMaster holds those descriptors open
until the remote command ends, so a 2s deadline took the full 30s of a `sleep 30`. The timeout bounds how
long Dwara waits, not how long the remote process runs; that is inherent to connection multiplexing.

2026-09-22 — **`doctor` probes with the argv the tools actually use.** Reason: a correctly scoped sudoers
grants verbs (`systemctl restart *`) and refuses the bare command, so a `<command> --version` probe fails on
well-configured hosts and passes on ones that hand out blanket root.

2026-09-28 — **Staged execution is an optional `apply(input, ctx)`, and a tool defines exactly one of
`build` or `apply`.** Reason: Phase 2 built every command up front, so nothing could depend on an earlier
command's output — `read_config` had to guard lexically first and re-check the resolved path afterwards to
work around it, and verification cannot work that way at all. `Ctx.run` already existed and `verify()` already
took a `Ctx`, so `apply` reuses one primitive rather than adding a second. `build` stays pure, which is what
lets a read tool's parser fixtures exercise it with no host in sight. Both defined would mean two answers to
"what does this run?", and under §9 the plan a human approves has to be the thing that actually runs; the
`BuiltToolDef` and `StagedToolDef` aliases make that a compile error, with the registry check as the runtime
backstop for callers that are not TypeScript.

2026-09-28 — **A tool's `apply` is sequencing, not an escape hatch.** Reason: `ctx.run` is the same
policy-checked transport the pipeline uses, the argv still comes from code in this repository, and every
element is still escaped individually — so `CLAUDE.md` rules 1 and 2 are untouched. What `apply` changes is
only who decides what runs next, and the policy decision was taken per tool and host before it was called.
One action stays one charge against the session budget however many commands it needs.

2026-09-28 — **Policy `health_checks` are translated into `HttpCheck` at the pipeline boundary, and run on
the host.** Reason: the verifier should not read YAML field names, and a schema change should break at one
translation site rather than everywhere a check is consumed. Running them on the host tests what the service
actually serves and needs no network path back to the developer machine. This makes the lab policy's
`https://127.0.0.1:8443/health` wrong — 8443 is the host-published port, and nginx inside `lab-api` listens
on 443 — which is the same class of bug as Phase 2's `open_ports` fixture: the tested path was not the path
the tool takes.

2026-09-28 — **A rollback's success is confirmed by observation, not by exit codes.** Reason: a
`Type=simple` unit reports a successful `systemctl start` the instant the fork succeeds, so rolling back
a service whose binary now exits 1 returns zero from every command while the unit crash-loops. Dwara
would then report `VERIFY_FAILED` with "the host is back as it was", which is the one claim it must never
get wrong. `confirmUnits` watches the recorded units for a few seconds after the undo and requires two
things: each is running if it was running, and its restart count has not climbed above what was recorded.
The second is what catches the loop — the same signal the verifier uses, for the same reason. Found by an
integration test that expected `VERIFY_FAILED` and was right to be suspicious when it got it.

2026-09-28 — **Rolling a unit back to "not running" also clears its failed state.** Reason: `systemctl
stop` on a unit that crashed leaves `ActiveState=failed`, not `inactive`. A rollback that stopped there
would leave the host in a state the snapshot never recorded, and leave the unit in `host_overview`'s
failed list indefinitely. `reset-failed` precedes both the start and the stop.

2026-09-28 — **`restart_service` refuses ssh, dbus, dbus-broker, systemd-journald and systemd-logind.**
Reason: the same standing as the path deny-list — a floor in code, not a default a policy file can lift.
Restarting sshd is a reasonable thing for a person at a console to do and a uniquely bad thing for an
agent to do, because the one failure it cannot recover from is losing the connection it would need to
recover. dbus and logind wedge systemd under a container init; journald holds the logs a diagnosis is
made of.

2026-09-28 — **The `reversible` risk class describes the kind of change, not a promise the host
recovers.** Reason: a restart is reversible in the sense that Dwara can put back what the unit was asked
to do. Whether it comes back healthy depends on why it was healthy before — if the fault is in what the
unit runs, `systemctl start` cannot fix it, and Dwara reports `ROLLBACK_FAILED` and says a human is
needed. That is the honest answer, and it is why the two error codes are distinct.

2026-09-29 — **A tool may guard its arguments in `snapshot()`, and the pipeline catches it there.**
Reason: `snapshot()` is the first thing called for a mutating tool, so a refusal raised while describing
what to back up happens before anything reaches the host — the right place for it. But it was being
called outside the pipeline's try block, so `restart_container` refusing a malformed name threw straight
out of `execute()` instead of returning a typed result, which `CLAUDE.md` forbids. A tool's own error
code and wording survive: "cannot snapshot" is the wrong thing to tell someone who asked to restart a
container Dwara will not touch.

2026-09-29 — **A container's `RestartCount` is checked the same way a unit's `NRestarts` is.** Reason:
`containerRunningAndHealthy` looked only at `Running` and the health status, so a container under
`--restart=always` that dies on boot passed verification — Docker restarts it within milliseconds, so it
reads as running at almost every poll. The service check had closed this exact gap and the container
check had not. Found when the matrix restarted a doomed container and the pipeline called it a success.

2026-09-29 — **A tool may declare `restorable: false`, and the pipeline then never claims the host is
back as it was.** Reason: freeing disk space genuinely cannot be undone — you cannot back up the thing
you are deleting onto the filesystem you are emptying, so `rotate_logs`'s snapshot is a record of what
went rather than a copy of it. Such a tool still defines `snapshot`, `verify` and `rollback`, because
`CLAUDE.md` rule 3 requires them, but its rollback has no commands to give. Without the flag a failed
verification would run an empty rollback, find nothing wrong with it, and report `VERIFY_FAILED` with
"the host is back as it was" — the same class of false claim that `confirmUnits` exists to prevent. With
it, the result says the change stands and points at the snapshot for what was removed. The code stays
`VERIFY_FAILED` rather than `ROLLBACK_FAILED`: nothing went wrong with the undo, because there was never
an undo to attempt.

2026-09-29 — **`rotate_logs` truncates; it does not delete, and it does not use `logrotate`.** Reason:
`truncate -s 0` keeps the inode, so the process holding the file open carries on writing to the same
place and the space returns immediately. Unlinking instead leaves the writer appending to a deleted
inode — the bytes stay allocated until that service restarts, so `df` does not move while every
indication says the fix worked. `logrotate` is not used because it acts only on files it already has a
configuration for, and a file with a working rule is rarely the one that filled the disk; the runaway
writer nobody configured is. It was installed in the lab image for this tool and has been removed again
rather than left as dead configuration.
