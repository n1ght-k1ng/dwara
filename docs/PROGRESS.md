# Progress

Handoff notes between Claude Code sessions. Update after every task.

## Current phase

Phase 0 — repo bootstrap and testbed. **Complete.** Exit criteria verified on
2026-09-22 (see "Phase 0 exit criteria" below).

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

## Things worth knowing before Phase 1

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

Phase 1 — core: types, policy engine, SSH transport, `dwara doctor`.
Kickoff prompt is in `docs/PLAN.md`. Write the policy test table and the escaping
property tests before any implementation, and add no tool definitions in that phase.

## Open questions

- Final project name and npm scope. Packages are `@dwara/*` and private for now.
- Model budget for the Phase 5 benchmark runs.
- Whether integration tests should run in CI with the testbed, or stay local until
  Phase 5. Phase 0 CI runs unit tests only.

## Dogfooding log (Phase 7)
