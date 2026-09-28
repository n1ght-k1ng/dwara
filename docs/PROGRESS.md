# Progress

Handoff notes between Claude Code sessions. Update after every task.

## Current phase

Phase 3 — mutations: snapshots, verifier, reversible and config tools, rollback.
**In progress.** Phases 0, 1 and 2 complete; exit criteria for all three verified.

### Phase 3 log

**Task 0 — pre-flight (2026-09-28).** Not a commit.

- **Docker Desktop was pausing itself.** `UseResourceSaver: true` with
  `AutoPauseTimeoutSeconds: 300` is the idle shutdown. Now off, with `AutoStart: true`
  so it survives a reboot, and the VM raised from 7869 MiB to 12288 — five systemd
  hosts plus Docker-in-Docker, Kafka and Postgres had 7.7 GB, and Phase 3 restarts
  services constantly. Settings live in `~/.docker/desktop/settings-store.json`;
  changing them restarts the daemon and takes the lab with it.
- **Node 22 runs clean.** nvm had only 20.20.2, so 22 had never run here at all. Both
  legs of the CI matrix now pass locally end to end: `format:check`, `lint`,
  `typecheck`, `test` (337 at the time), `build`.
- **CI itself is still unconfirmed.** `gh` is not installed and the repo is private, so
  the Actions tab is not readable from this machine. The local matrix run is the same
  job, so a red build would be environment-specific rather than code.

**Task 1 — staged execution (2026-09-28).** `feat(core)`.

Resolves the first of the two things Phase 2 left open. A tool now defines exactly one
of `build` (pure, every command known from the input) or `apply` (sequences its own
commands through `ctx.run`, so a later one can use an earlier one's output). Enforced
in the type system by `BuiltToolDef` / `StagedToolDef` and at registration as a runtime
backstop. `Ctx` gained the host's `httpChecks`, translated out of policy; `SnapshotRef`
gained the `hashes` that make a restore provable; five mutation error codes added.
348 unit tests.

## Done

**Repo setup**
- Git repo on `main`, repo-local author `nikhilreddy <dn.reddy@hotmail.com>`.
- `CLAUDE.md` at the root; `DESIGN.md`, `PLAN.md`, `PROGRESS.md` under `docs/`.
  `dwara-plan.zip` is gitignored — its contents are the files above.

**Monorepo**
- pnpm workspace with six stub packages: `core`, `tools`, `mcp-server`, `cli`, `hook`,
  `plugin-claude-code`. No Dwara logic yet; that starts in Phase 1.
- Strict TS (NodeNext, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`), flat ESLint
  config with `@typescript-eslint/no-explicit-any` as an error, Prettier, tsup, Vitest
  with separate `unit` and `integration` projects.
- `testbed/app` is deliberately **outside** the workspace so the lab app's dependencies
  never enter Dwara's install or CI.
- Node 20+ required (`.nvmrc`). The machine's default `node` is 18, so `nvm use` first.

**CI** (`.github/workflows/ci.yml`)
- Matrix over Node 20 and 22: format check, lint, typecheck, unit tests, build.
- Separate shellcheck job for the testbed scripts.

**Testbed** (see `testbed/README.md` for the full picture)
- Five systemd+sshd hosts: `lab-api`, `lab-db`, `lab-cache`, `lab-queue`, `lab-staging`,
  on 127.0.0.1:2201-2205, key-only auth, scoped sudo allowlist.
- Dummy NestJS app with `GET /health` reporting Postgres, Redis and Kafka separately.
- `pnpm testbed:up | down | reset | status | break`.
- Five break scenarios, each with a `--check` mode that asserts the failure is live.
- `DWARA_TESTBED=1 pnpm test:integration` smoke-tests the lab.

## Phase 0 exit criteria

- [x] Monorepo builds, lints, typechecks and tests. `pnpm format:check && pnpm lint &&
      pnpm typecheck && pnpm test && pnpm build` all pass locally; CI runs the same on
      Node 20 and 22. CI itself has not run yet — there is no remote.
- [x] All five lab hosts reachable over SSH with key auth only. Password auth is
      refused, and sudo outside the allowlist is denied.
- [x] Healthy baseline and five reproducible failures, each resettable. Every scenario
      was applied, confirmed live with its own `--check`, and recovered with
      `pnpm testbed:reset`.
- [x] 14/14 integration smoke tests pass against the running lab.

**Phase 1: core**
- `types.ts` and `errors.ts`: the shapes from DESIGN section 5 and a closed set of
  `DwaraError` codes.
- Policy: zod schema (strict), loader with a SHA-256 hash of the raw bytes, host glob
  matching with specificity, and the evaluator. **100% statements/branches/functions/lines
  on `packages/core/src/policy/**`**, enforced by a coverage threshold in CI.
- SSH: argv escaping, an ssh_config parser (Include, globs, negation), and the transport
  over the system `ssh` binary.
- `dwara doctor`, plus `testbed/policy.yaml` as a committed example policy.
- 158 unit tests, 28 integration tests against the lab.

## Phase 1 exit criteria

- [x] 100% branch coverage on the policy evaluator. `pnpm test:coverage` enforces it.
- [x] Escaping property tests pass at 10,000+ generated inputs, verified against a real
      shell rather than against shell-quote's own parser.
- [x] `dwara doctor -F testbed/ssh_config --policy testbed/policy.yaml` reports all five
      hosts healthy, and flags a host whose sudoers file has been removed with the exact
      line to restore.

**Phase 2: the agent-facing layer**
- Redactor: pattern rules plus an entropy fallback, measured on a committed corpus —
  **zero leaks on 109 positives, under 2% false positives on 106 negatives.**
- Untrusted-data envelope that flags injection attempts without blocking them.
- Hash-chained audit log at `.dwara/audit.jsonl`, with `verifyChain` detecting an
  edit, a deletion, a reorder or a truncation by line number.
- Session, registry and the execution pipeline (DESIGN §3, in order).
- **Eleven read tools**, parsers tested against 48 captured fixtures.
- MCP stdio server exposing them as `read_*`, plus `runbooks/` as resources.
- 84 tools tests, 40 integration tests, 420 in total.

## Phase 2 exit criteria

- [x] **5 of 5 break scenarios root-caused** by Claude Code using only Dwara tools.
      The criterion was ≥4. Transcripts and audit logs per scenario; every chain
      verified. Scored below.
- [x] No corpus secret appears in any tool output — enforced by the redactor corpus
      test, and the pipeline redacts parsed output, error messages and audit inputs.
- [x] Audit chain verifies after a full diagnosis session, on all six gate runs.

### Gate results (2026-09-28, `claude -p`, Dwara tools only, no shell)

| Scenario | Verdict | Root cause identified |
|---|---|---|
| `api-crash-loop` | pass | Postgres rejects the password for `labapp`, app exits at boot, systemd restarts it forever |
| `nginx-bad-config` | pass | nginx proxies to `127.0.0.1:3999`, app listens on `3000`, every request refused |
| `redis-down` | pass | `redis-server` stopped and masked on lab-cache, app gets ECONNREFUSED on 6379 |
| `postgres-max-connections` | pass | connection slots exhausted; named the exact Postgres error and hedged correctly on *why* the limit changed |
| `disk-full-logs` | **failed, then passed** | see below |

`disk-full-logs` failed on the first run and the audit log said why: twenty tool
calls on lab-api, and **not one of them reached `disk_usage`** on a scenario whose
entire cause is a full filesystem. That was a design gap, not a model failure —
`host_overview` is the orientation tool, it reported memory, and it said nothing
about disk, so nothing pointed that way. After adding filesystem pressure to
`host_overview`, `disk_usage` became the **third** call and the root cause came
with byte-level evidence.

## Bugs the exit gate found that every unit test had missed

Worth keeping, because they are the argument for the gate existing at all:

- **`docker_ps` could not be called.** Its `--format` template used tabs, and the
  transport refuses control characters in arguments — two of our own decisions in
  direct conflict. Now `{{json .}}`, which needs no delimiter and carries Docker's
  own `State` and `HealthStatus`.
- **`open_ports` returned every port with no number.** `ss` prints the Netid column
  only when more than one protocol is requested, so `-tlnp` and `-tulnp` have
  different shapes. The fixture came from `-tulnp` while the tool's default is
  `-tlnp` — **the tested path was not the path the tool takes.**
- **`read_config` had no sudoers rule.** `redis.conf` is `root:redis` mode 0640, so
  the read genuinely needs root.
- **`max_actions_per_session: 20`** (the DESIGN example value) is too low for a real
  diagnosis. Raised to 60 in the lab policy. The limit itself behaved exactly as
  specified: 20 executed, 4 refused, refusals not charged.

## Two bugs the Phase 1 tests found, worth remembering

- **shell-quote corrupts `!`.** Its `quote()` emits `\!` inside double quotes for
  interactive bash; a non-interactive shell passes the backslash through literally. Any
  grep pattern or path containing `!` would have been silently altered. Dwara now does its
  own POSIX single-quoting; shell-quote stays for the hook's *parsing* in Phase 4.
- **Timeouts did not time out.** execa kills the ssh client then waits for its stdio to
  close, and the ControlMaster holds those descriptors until the remote command ends — a
  2s deadline took 30s. The transport now runs its own timer. Pinned by an assertion on
  elapsed time, not just on the error code.

## Things worth knowing

- **Docker-in-Docker** needs `/var/lib/docker` *and* `/var/lib/containerd` on volumes;
  without the second, overlay mounts inside a lab host fail with `EINVAL`.
- **Kafka** listeners bind to the routable `lab-queue` address, not `0.0.0.0`: the
  apache/kafka entrypoint formats storage before launch and rejects a non-routable
  advertised address at that step.
- **Host keys** change whenever a lab image is rebuilt, so `up.sh` drops the stale
  `known_hosts` entries. Host key checking stays on — it is not disabled for the lab.
- **`reset` is a full recreate**, not an in-place repair, because the Phase 5 benchmark
  needs an identical starting state per scenario.
- Lab images and volumes are worth roughly 6 GB; `pnpm testbed:down --volumes` reclaims it.

## Next

Phase 3 — mutations: snapshots, verifier, reversible and config tools, rollback.
Kickoff prompt is in `docs/PLAN.md`. Build the snapshot manager and verifier
**before** any mutating tool, and no mutating tool counts as done without the full
test matrix: success, verify-failure-triggers-rollback, timeout mid-action,
rollback restores exact file hashes, idempotent re-run.

Two things Phase 2 leaves for Phase 3 to resolve:

- **Staged execution.** A tool's commands are built up front, so a later command
  cannot depend on an earlier one's output. `read_config` works around it by
  guarding lexically first and re-checking the resolved path afterwards, and says
  so in its comments. Phase 3's verify step needs the real thing.
- **Approval is a dead end today.** The pipeline stops at an approval requirement
  and reports that no tool can grant one, which is correct but leaves `config_*`
  tools unusable until Phase 4 builds the CLI flow.

## Running the gate again

```bash
pnpm build && pnpm testbed:up
# per scenario: reset, break, then claude -p with only Dwara tools
claude -p "<prompt>" --mcp-config <config> --allowedTools mcp__dwara__read_* \
  --disallowedTools Bash Read Write Edit Glob Grep WebFetch WebSearch Task
```

The harness used for the 2026-09-28 run lives in the session scratchpad rather than
the repo; Phase 5 replaces it with the real benchmark runner under `evals/`.

## Open questions

- Final project name and npm scope. Packages are `@dwara/*` and private for now.
- Model budget for the Phase 5 benchmark runs.
- Whether integration tests should run in CI with the testbed, or stay local until
  Phase 5. CI runs unit tests only so far.
- ~~Session accounting~~ — resolved in Phase 2: `Session` owns the counter and charges
  only actions that reached a host.
- Whether `host_overview` should also carry a cheap check of the host's main service
  ports. The gate suggests orientation tools earn their place by pointing somewhere.

## Dogfooding log (Phase 7)
