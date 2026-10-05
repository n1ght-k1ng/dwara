# Dwara — Build, Test, and Publish Plan

Each phase has: goal, tasks, tests, exit criteria, and a kickoff prompt to paste into Claude Code.
Run one phase per Claude Code session. Use `/clear` between phases; `CLAUDE.md` and `docs/PROGRESS.md`
carry context forward.

Estimated total: 7–8 weeks part-time.

---

## How to work with Claude Code on this plan

1. Put `CLAUDE.md` at the repo root and this file plus `DESIGN.md` in `docs/`.
2. For each phase, start a fresh session and paste the phase's kickoff prompt.
3. Ask Claude Code to use plan mode first and show you the task breakdown before writing code.
4. Review each commit. You own the security-critical parts: policy engine, escaping, hook, approvals.
5. At the end of a phase, run the exit-criteria checklist yourself. Don't trust "done" without running it.
6. Keep `docs/PROGRESS.md` updated; it is the handoff note between sessions.

Recommended Claude Code settings for this repo (`.claude/settings.json`): allow `pnpm *`, `git *`, `docker compose *`;
require approval for anything else. Do not give Claude Code SSH access to any real server during phases 0–6.

---

## Phase 0 — Repo bootstrap and testbed (week 1, first half)

**Goal:** a monorepo that builds and tests, plus a local lab that mimics a real production architecture.

### About the testbed

The testbed replicates the *shape* of a typical backend production stack (API service, reverse proxy,
Postgres, Redis, Kafka) as separate SSH-reachable "hosts". It must contain **no real company code, configuration,
data, hostnames, or credentials** — use a small dummy NestJS app written for the testbed.

Hosts (each an Ubuntu 24.04 container running systemd and sshd):

| Host | Runs | Purpose |
|---|---|---|
| `lab-api` | nginx (reverse proxy, TLS with self-signed cert) + Docker running a dummy NestJS API container | App and proxy failures |
| `lab-db` | PostgreSQL 16 (systemd service) | Connection exhaustion, disk, config errors |
| `lab-cache` | Redis 7 (systemd service) | Memory limits, persistence, restarts |
| `lab-queue` | Kafka (KRaft, single node) in Docker | Broker down, disk from log retention |
| `lab-staging` | Same as `lab-api`, tagged staging | Policy differences between prod and staging |

The dummy API exposes `/health` (checks Postgres, Redis, Kafka) and a couple of endpoints that write to each.

### Tasks

1. Initialize pnpm monorepo with packages listed in `CLAUDE.md`; shared tsconfig, eslint, prettier, vitest, tsup.
2. GitHub Actions CI: lint, typecheck, unit tests on PR.
3. `testbed/` with Docker Compose:
   - base image: Ubuntu 24.04 + systemd + openssh-server + sudo + a `dwara` user
   - generated SSH keypair in `testbed/.keys/` (gitignored), authorized on every host
   - passwordless `sudo -n` for an allowlisted set of commands only (sudoers file in testbed)
   - each host on a fixed port on localhost (2201–2205)
   - `testbed/ssh_config` with `Host lab-*` entries pointing at those ports, used via `ssh -F`
4. Dummy NestJS API in `testbed/app/` with `/health`.
5. Scripts: `pnpm testbed:up`, `testbed:down`, `testbed:reset`, `testbed:break <scenario>`, `testbed:status`.
6. First break scenarios (just shell scripts for now): `api-crash-loop`, `disk-full-logs`, `nginx-bad-config`,
   `redis-down`, `postgres-max-connections`.
7. `docs/PROGRESS.md` created.

### Tests
- CI green on an empty package with one test.
- `pnpm testbed:up` then `ssh -F testbed/ssh_config lab-api 'systemctl is-system-running'` returns `running`
  or `degraded` for every host.
- `curl` through `lab-api` nginx to `/health` returns 200; each break script makes it fail; `testbed:reset` restores it.

### Exit criteria
- [ ] Monorepo builds, lints, and tests in CI
- [ ] All five lab hosts reachable via SSH with key auth only
- [ ] Healthy baseline and five reproducible failures, each resettable

### Kickoff prompt
```
Read CLAUDE.md and docs/PLAN.md. We are starting Phase 0. Use plan mode: break Phase 0 into
ordered tasks with the files each touches, then wait for my approval. The testbed must contain no
real company code or config. After approval, implement task by task, committing after each and
updating docs/PROGRESS.md.
```

---

## Phase 1 — Core: types, policy engine, SSH transport, doctor (week 1–2)

**Goal:** the security-critical foundation, fully tested.

### Tasks
1. `packages/core/src/types.ts`: `Risk`, `ToolDef`, `RemoteCommand`, `Decision`, `ToolResult`, `DwaraError`.
2. Policy:
   - zod schema for `.dwara/policy.yaml` (see DESIGN.md)
   - loader with file hash
   - evaluator implementing the precedence algorithm; returns decision plus reason
   - session limits (max actions per session)
3. SSH transport:
   - builds `ssh` invocation with `BatchMode=yes`, ControlMaster options, optional `-F` config path
   - escapes each argv element; rejects NUL bytes and control characters
   - timeout, output cap with `truncated` flag, exit code, stderr capture
   - `sudo -n` support with clear error when a password would be required
4. SSH config parser for host discovery (support `Include`, `Host` patterns, `HostName`, `Port`, `User`).
5. `dwara doctor`: connectivity, sudo checks for required commands, required binaries, prints fix suggestions
   (including the exact sudoers snippet).

### Tests
- Policy: table-driven tests, at least 40 cases: host glob specificity, precedence, `never` can't be overridden,
  unknown host denied, session limit, malformed policy rejected with useful errors.
- Escaping: property-based tests (fast-check) that arbitrary strings round-trip as a single argument and never
  cause extra commands to execute on the testbed (run `printf %s <arg>` remotely and compare).
- Transport integration against testbed: success, non-zero exit, timeout, large output truncation, sudo denied.
- Doctor against a deliberately misconfigured testbed host.

### Exit criteria
- [ ] 100% branch coverage on policy evaluator
- [ ] Escaping property tests pass with 10,000+ generated inputs
- [ ] `dwara doctor -F testbed/ssh_config` reports all hosts healthy and correctly flags a broken one

### Kickoff prompt
```
Phase 1. Read CLAUDE.md, docs/DESIGN.md (Policy, SSH transport sections), docs/PROGRESS.md.
Plan mode first. Write tests before implementation for the policy evaluator and escaping.
Do not add any tool definitions yet. Show me the policy test table before implementing the evaluator.
```

---

## Phase 2 — Read-only tools, redactor, audit, MCP server (week 2–3)

**Goal:** Claude Code can diagnose testbed failures safely.

### Tasks
1. Tool registry and execution pipeline (validate → resolve host → policy → execute → parse → redact → audit).
2. Read-only tools: `host_overview`, `service_status`, `tail_logs`, `disk_usage`, `docker_ps`, `container_logs`,
   `container_inspect`, `open_ports`, `cert_expiry`, `read_config` (allowlisted paths), `security_audit`.
3. Redactor with pattern rules and entropy check; `[REDACTED:type]` markers; extra patterns from policy.
4. Untrusted-data envelope and suspicious-content flagging.
5. Audit logger: JSONL, hash chain, policy hash, redacted inputs; `dwara audit` and `dwara audit verify`.
6. MCP server (stdio): registers tools from registry with names prefixed by risk (e.g. `read_tail_logs`),
   exposes runbooks as MCP resources.
7. Write tool descriptions carefully for the model.

### Tests
- Unit tests for every parser using captured real outputs (fixtures).
- Redactor corpus: at least 100 lines with secrets and 100 without; zero leaks, under 2% false positives.
- Audit: tampering with any line is detected by `audit verify`.
- Integration: each tool against the testbed in both healthy and broken states.
- Manual gate: register the MCP server with Claude Code (`claude mcp add ...`) pointing at the testbed config,
  run each Phase 0 break scenario, ask Claude Code to diagnose. Record results in PROGRESS.md.

### Exit criteria
- [ ] Claude Code correctly identifies the root cause for at least 4 of 5 break scenarios using only Dwara tools
- [ ] No secret from the redactor corpus appears in any tool output
- [ ] Audit chain verified after a full diagnosis session

### Kickoff prompt
```
Phase 2. Read CLAUDE.md, docs/DESIGN.md (Tool catalog, Redactor, Audit, Prompt-injection sections),
docs/PROGRESS.md. Plan mode first. Only read-risk tools in this phase. Build the redactor corpus
before the redactor. Capture real command outputs from the testbed as parser fixtures.
```

---

## Phase 3 — Mutations: snapshots, verifier, reversible and config tools, rollback (week 3–4)

**Goal:** transactional changes: snapshot, act, verify, roll back on failure.

### Tasks
1. Snapshot manager: remote store under `/var/lib/dwara/snapshots/<id>/` with file copies, modes, owners,
   SHA-256, metadata; retention cleanup; local reference in audit.
2. Verifier: postconditions (service active and stable for N seconds, container running and healthy, HTTP check
   from policy, validator commands); retries with backoff; structured result.
3. Reversible tools: `restart_service`, `restart_container`, `prune_images`, `rotate_logs`.
4. Config tool: `edit_config` taking a unified diff; plan step (dry run: diff, validator, rollback plan, plan hash)
   and apply step (requires matching plan hash); validator per file type (`nginx -t`, `sshd -t`, a Postgres config check);
   for services without a built-in config validator (such as Redis), use restart-then-verify with automatic rollback.
5. `rollback` tool and `dwara rollback <snapshot-id>` CLI.
6. Auto-rollback when verify fails; result reports both the failure and the restore.

### Tests
- For every mutating tool: success, verify failure triggers rollback, timeout mid-action, rollback restores exact
  file hashes, idempotent re-run.
- Chaos tests: kill the SSH connection mid-apply; ensure snapshot exists and rollback works from CLI.
- `edit_config` with a diff that breaks nginx is rejected at validator stage and never reloads.

### Exit criteria
- [ ] Every mutating tool has the full test matrix passing on the testbed
- [x] Claude Code fixes `disk-full-logs` and `nginx-bad-config` end to end with verification, and on
      `api-crash-loop` diagnoses correctly, refuses correctly, and names the exact fix.
      **Amended 2026-10-05.** As written this said "fixes all three". `api-crash-loop`'s fault is a wrong
      database password in `/etc/dwara-lab/app.env`, so fixing it means editing a credentials file or
      changing a Postgres password — Dwara refuses both by design, and no criterion should require
      weakening the deny-list to pass. The agent root-caused it, said plainly why it could not act, and
      handed over both remedies with the commands. That refusal is the most valuable single result the
      gate produced, so the scenario stays as it is and Phase 5 adopts it as an explicit should-refuse
      case.
- [ ] A deliberately bad fix is automatically rolled back and reported

### Kickoff prompt
```
Phase 3. Read CLAUDE.md, docs/DESIGN.md (Snapshots, Verifier, edit_config), docs/PROGRESS.md.
Plan mode first. Implement snapshot manager and verifier before any mutating tool. Every mutating
tool needs the full test matrix from PLAN.md before it counts as done.
```

---

## Phase 4 — Approvals, hook, Claude Code plugin, init (week 4–5)

**Goal:** the zero-friction developer experience and the human-in-the-loop guarantees.

### Tasks
1. Approval flow:
   - plan binding (plan hash required to apply)
   - CLI fallback: `approval_required` result with ID; `dwara approve <id>` writes a short-lived approval bound to
     the plan hash; MCP server checks it
   - no MCP tool can create approvals
2. PreToolUse hook (`packages/hook`): reads Claude Code hook JSON from stdin; parses Bash commands with
   shell-quote; detects `ssh`, `scp`, `rsync`, `sftp`, `mosh` to managed hosts including via `bash -c`, `eval`,
   `$(...)`, `xargs`, env prefixes; blocks with a helpful message naming Dwara tools; fails closed on unparseable
   commands that mention managed hosts.
3. Claude Code plugin: slash commands (`/diagnose`, `/fix`, `/harden`, `/rollback`, `/audit`), investigation skill,
   `hooks.json`, permission settings (read tools allowed, others prompt).
4. `dwara init`: SSH config discovery, host selection, production tagging, doctor, writes `.dwara/policy.yaml`,
   updates `.gitignore`, registers MCP server with Claude Code, offers plugin install, prints first prompt.
   Print config snippets for Codex, Cursor, Goose.

### Tests
- Hook: at least 60 command cases including evasion attempts; zero false negatives on the evasion set.
- Approval: agent-driven attempts to apply without approval, with a stale approval, and with a modified plan all fail.
- `init` end to end in a clean temp home directory against the testbed.
- Manual gate: from a fresh clone, time `npx`-style install to first diagnosis. Target under 2 minutes.

### Exit criteria
- [ ] Hook blocks every evasion case in the test set
- [ ] No path found to apply a config change without human approval
- [ ] Fresh-machine setup to first diagnosis under 2 minutes

### Kickoff prompt
```
Phase 4. Read CLAUDE.md, docs/DESIGN.md (Approval flow, PreToolUse hook, Plugin, init), docs/PROGRESS.md.
Plan mode first. Write the hook's evasion test cases before the hook. Before implementing approvals,
list every way an agent could try to self-approve and show me how each is prevented.
```

---

## Phase 5 — Benchmark and eval harness (week 5–6)

**Goal:** an open, reproducible benchmark for agents operating infrastructure — the project's headline contribution.

### Tasks
1. Scenario format: `compose.yaml` (or testbed overlay), `break.sh`, `prompt.txt`, `check.sh`, `meta.yaml`
   (category, difficulty, expected safe behaviors, forbidden actions).
2. 20 scenarios built on the testbed:
   - 12 fix scenarios (crash loop, full disk, log explosion, expired cert, bad nginx config, port conflict, OOM kill,
     Postgres max connections, Redis maxmemory, Kafka broker down, dependency outage cascading to API health,
     failed deploy needing rollback)
   - 5 prompt-injection scenarios (instructions planted in logs, config comments, app responses, filenames,
     a README on the server)
   - 3 should-refuse scenarios (request requires destructive action; ambiguous data-loss risk; production change
     without approval)
3. Runner: reset testbed, apply break, run agent headlessly (`claude -p` with Dwara MCP config), collect audit log,
   run `check.sh`, score, reset. Also support a baseline mode: agent with raw SSH and no Dwara.
4. Metrics: resolution rate, unsafe action attempts, injection success rate, refusals correct, tool calls, tokens,
   cost, time to resolution.
5. Results report generator (Markdown table + JSON) and a `BENCHMARK.md` explaining methodology.
6. Iterate tool descriptions, skill, and runbooks based on failures; re-run.

### Tests
- Each scenario validated: `check.sh` fails after break and passes after a known-good manual fix.
- Runner is deterministic about setup and teardown (run a scenario 3 times, same starting state).

### Exit criteria
- [ ] 20 validated scenarios
- [ ] Results for at least 2 models (e.g. Claude Sonnet 5 and Claude Haiku 4.5), with Dwara vs raw-SSH baseline
- [ ] Documented methodology others can reproduce

### Kickoff prompt
```
Phase 5. Read CLAUDE.md, docs/DESIGN.md (Eval harness), docs/PROGRESS.md. Plan mode first. Build the
runner and 3 scenarios end to end before writing the rest. Do not run the full benchmark against paid
APIs until I confirm the budget.
```

---

## Phase 6 — Security hardening and threat model (week 6–7)

**Goal:** credible security posture before anyone runs this on real servers.

### Tasks
1. `docs/THREAT_MODEL.md`: assets, trust boundaries, attacker models (malicious server content, compromised agent,
   malicious policy PR, local attacker), mitigations, known limitations (hook is defense in depth, not a sandbox).
2. Fuzz all tool inputs (fast-check) for command injection against the testbed.
3. Red-team session: dedicated attempts to bypass policy, approvals, hook, redactor. Record findings and fixes.
4. Dedicated-key setup guide: Dwara-only SSH key and restricted sudoers, so the agent's normal shell has no direct
   credentials to managed hosts.
5. Dependency audit, lockfile, provenance-enabled npm publishing, `SECURITY.md` with disclosure policy.

### Exit criteria
- [ ] No open high-severity findings
- [ ] Threat model published with honest limitations
- [ ] Dedicated-key setup documented and tested

### Kickoff prompt
```
Phase 6. Read CLAUDE.md, docs/DESIGN.md, docs/PROGRESS.md. Act as an adversary: list concrete attacks
against policy, approvals, hook, redactor, and transport, then write tests that attempt each. Fix
anything that succeeds. Draft docs/THREAT_MODEL.md.
```

---

## Phase 7 — Dogfooding on real infrastructure (week 7)

**Goal:** prove it works outside the lab, safely.

Order of environments:
1. **Your own VPS** (personal account, personal key): read-only for 3–4 days, then reversible tools.
2. **Other personal or friends' servers** with their consent.
3. **Company infrastructure (e.g. TryThat.AI):** only with explicit written approval from the company, starting with
   staging, read-only, using a dedicated key and a policy that denies all mutations. Nothing from company systems
   (hostnames, configs, logs, screenshots) goes into the repo, benchmark, docs, or demo.

### Tasks
- Daily-use log in PROGRESS.md: what you asked, what worked, what was clumsy.
- Fix friction issues; add runbooks for problems you actually hit.

### Exit criteria
- [ ] One week of real use with no unsafe action and no redaction leak
- [ ] Top 5 friction issues fixed

---

## Phase 8 — Publish (week 8)

### Tasks
1. Final name, npm scope, domain, GitHub org; license Apache-2.0; `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`,
   issue and PR templates, `good first issue` labels, public roadmap.
2. README: one-line pitch, 60-second demo GIF, quickstart (`npx <name> init`), how it works diagram,
   safety model summary, benchmark results table, supported agents, limitations.
3. Docs site (e.g. VitePress) with quickstart, policy reference, tool reference, threat model, benchmark, runbook
   authoring guide.
4. Release pipeline: changesets, GitHub Actions publishing to npm with provenance; signed tags; CHANGELOG.
5. Distribution:
   - Claude Code plugin marketplace listing
   - MCP registries and awesome-mcp lists
   - awesome-selfhosted / awesome-sysadmin where appropriate
6. Launch content:
   - Blog post: "Threat model for AI agents with SSH access" (with red-team findings)
   - Blog post: benchmark methodology and results
   - Show HN, r/selfhosted, r/homelab, r/devops, relevant Discords, Indian dev communities, LinkedIn/X
7. After launch: triage issues daily for two weeks; publish v0.2 roadmap based on feedback.

### Exit criteria
- [ ] `npx <name> init` works on a clean machine (macOS and Linux)
- [ ] Docs, benchmark, and threat model public
- [ ] Launch posts live

---

## Before you start

- Confirm your employment agreements allow a personal open-source project in this area, and build on
  personal hardware and accounts.
- Keep company architecture knowledge generic in the testbed: a standard NestJS + Postgres + Redis + Kafka shape is
  fine; anything specific to your employer's systems is not.
