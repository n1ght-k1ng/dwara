# Progress

Handoff notes between Claude Code sessions. Update after every task.

## Current phase

Phase 1 — core: types, policy engine, SSH transport, doctor. **Complete.**
Phase 0 complete before it. Exit criteria for both verified on 2026-09-22.

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

## Two bugs the tests found, worth remembering

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

Phase 2 — read-only tools, redactor, audit log, MCP server. Kickoff prompt is in
`docs/PLAN.md`. Build the redactor corpus before the redactor, and capture real command
output from the testbed as parser fixtures rather than inventing them.

The registry and execution pipeline sit on top of what Phase 1 built: `evaluate()` for the
decision, `SshTransport` for execution, `DwaraError` for failures. Nothing in Phase 2
should need to touch escaping or policy semantics again.

## Open questions

- Final project name and npm scope. Packages are `@dwara/*` and private for now.
- Model budget for the Phase 5 benchmark runs.
- Whether integration tests should run in CI with the testbed, or stay local until
  Phase 5. CI runs unit tests only so far.
- Session accounting: `evaluate()` reads `actionsUsed` and never changes it, so something
  in Phase 2 has to own the counter and increment it only on executed actions.

## Dogfooding log (Phase 7)
