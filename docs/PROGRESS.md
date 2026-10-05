# Progress

Handoff notes between Claude Code sessions. Update after every task.

## Current phase

Phase 4 — approvals, hook, Claude Code plugin, init. **In progress.**
Phases 0 through 3 complete; **Phase 3's exit criteria all met** as of 2026-10-05,
when the `api-crash-loop` criterion was amended rather than the scenario changed.

### Phase 4 log

**Tasks 2 and 3 — the PreToolUse hook (2026-10-05).** `feat(hook)`.

93 tests: a 67-case evasion corpus in `packages/hook/src/evasions.ts` plus the wrapper. **Zero false
negatives**, asserted as one statement rather than inferred from a page of green ticks.

The corpus was written against **measured** `shell-quote` behaviour, and the measuring found five things
that would each have been a silent hole:

- **`ssh $HOST` parses to `['ssh', '']`.** The variable becomes an empty string, so the host does not
  survive as anything recognisable — it simply vanishes, and a detector looking for a managed hostname
  finds nothing and allows it.
- **`bash -c "ssh $H"` parses to `['bash','-c','ssh ']`.** The variable is erased *inside* the string,
  so by the time there are tokens there is no trace there ever was one. Caught by checking the raw text
  for a variable reference before parsing.
- **Backticks are never interpreted.** `` `ssh lab-api x` `` yields ``['`ssh', ...]`` — the verb wears a
  stray backtick and an equality check on `'ssh'` misses it.
- **Inside double quotes, `$(...)` is NOT flattened.** `echo "$(ssh lab-api x)"` comes back as one
  literal token, so the inner command never becomes tokens at all. Unquoted, the same substitution *is*
  flattened. Both shapes now go through a raw-text substitution extractor.
- **Unbalanced quotes do not throw.** `ssh lab-api"` parses cleanly, so a parse failure cannot be relied
  on to catch malformed input.

Quote-splitting (`s''sh`) and backslashes (`\ssh`) are normalised back to `ssh` by the parser and need
no handling — they are in the corpus so a future parser change that stops normalising them fails a test
instead of opening a hole.

The verdict is **three-valued**. `unreadable` is not a hedge: it is the honest answer when a command
could reach a managed host and the hook cannot tell, and it is reported as that rather than dressed up
as a match. A denial names the host, the verb, and the Dwara tool to use instead — a block the model
cannot act on just produces a second attempt.

**With no policy, the hook stays silent**, including for commands it would otherwise refuse. A plugin
installed globally must not break the projects that do not use Dwara.

671 unit tests.

**Task 4 — adversarial review of self-approval (2026-10-05).** `fix(core)`, `docs`.

`docs/THREAT_MODEL.md` started: fourteen routes an agent could take to approve its own action, what
stops each, and the test that pins it. A row without a test is a claim, not a control.

**One of them worked.** The pipeline called `find(planHash)` then `consume(id)` as two steps, and
between them was a window: two concurrent calls both found the same unused approval and both went on to
spend it. Not theoretical — **Claude Code issues tool calls in parallel**, so an agent could ask for one
approval and make the change twice. Reproduced before fixing.

The damage was bounded, since both calls carry the same plan hash and so do the thing the human
approved, twice. But "an approval is good for exactly one action" was a claim Dwara made and could not
keep, and for `edit_config` that is two writes.

Fixed by replacing both steps with a single `claim(planHash)` whose lock is an **exclusive file create**
— the filesystem makes it indivisible, and the loser gets `EEXIST`. `ApprovalStore` no longer exposes a
method that can be used the unsafe way, which matters more than the fix: the old interface made the
wrong thing easy and the right thing require care.

675 unit tests, 123 integration.

## Phase 3 exit criteria

- [x] Every mutating tool has the full test matrix passing on the testbed — six tools,
      each with success, verify-failure-triggers-rollback, timeout mid-action, rollback
      restores the recorded state, and idempotent re-run.
- [x] A deliberately bad fix is automatically rolled back and reported.
- [x] `dwara audit verify` passes after every gate run.
- [x] Claude Code fixes `disk-full-logs` and `nginx-bad-config` end to end, and on
      `api-crash-loop` diagnoses correctly, refuses correctly, and names the exact fix.
      **Criterion amended 2026-10-05** rather than the scenario: see `docs/PLAN.md`.
      Phase 5 adopts `api-crash-loop` as an explicit should-refuse case.

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

**Task 2 — snapshot manager (2026-09-28).** `feat(core)`.

`createSnapshot` / `restoreSnapshot` / retention, under
`/var/lib/dwara/snapshots/<id>/`. Two properties do the work:

- **A snapshot proves itself.** After `cp --preserve=all --parents`, the copies are
  hashed and compared against the originals; a mismatch throws `SNAPSHOT_FAILED` and
  `meta.json` is never written, so a directory holding one is a snapshot that
  completed. A snapshot that silently copied nothing is worse than none, because the
  pipeline would then change a host believing it could undo it.
- **A restore is checked, not assumed.** `SnapshotRef.hashes` is captured up front and
  re-checked after the restore, so "rollback restores exact file hashes" is testable
  rather than asserted. A `cp` that exits zero and writes different bytes — a full disk
  truncating the write — is still a failed restore.

The deny-list moved from `@dwara/tools` to `@dwara/core`: it governs every path that
reaches a command, not only ones a read tool opens, and a snapshot leaves a root-owned
copy behind. `packages/tools/src/paths.ts` re-exports it and keeps the read allow-lists.

Output shapes were captured from a lab host before the parsers were written, per the
Phase 2 lesson: `systemctl show` returns properties **out of the requested order** (a
real host answers `NRestarts` first), so unit blocks are keyed by `Id`; `stat` **exits 1
when any path is missing but still prints the ones that exist**, so presence is read
from stdout, not the exit code.

377 unit tests.

**Task 5, pulled forward — testbed grants and two missing binaries (2026-09-28).**
`chore(testbed)`.

Moved ahead of Tasks 3 and 4 because the snapshot manager could not be tested against
a host without it.

- **`logrotate` was missing from the lab images** and is now installed. `patch` is still
  missing and stays that way: `edit_config` applies diffs locally (see DESIGN).
- Snapshot, retention, rotate and docker verbs added to the lab sudoers. Every rule that
  writes pins its destination, which is **why the manager copies one file per `cp`** — a
  batched copy takes a variable number of sources and the rule would have to end in a
  bare `*`, a grant to copy anything anywhere as root. Retention is written out in three
  exact forms rather than `find /var/lib/dwara/snapshots *`, because a wildcard tail
  would permit `-exec rm -rf /etc {} +`.
- Verified on the host: all nine commands Dwara issues are permitted, and eight abuse
  cases — `cp /etc/shadow /tmp`, `rm -rf /etc`, `tee -- /etc/passwd`,
  `docker image prune -a -f`, `find /etc -exec rm` among them — are all refused.
- 13 snapshot integration tests on `lab-staging`. The code under test goes over SSH with
  only the grants the lab gives it; fixtures go in as root via `docker exec`, because
  arranging the world is the harness's job and Dwara is deliberately not allowed to.

**Two bugs this task caught before they shipped:**

- **`find -printf '%T@ %f\n'` cannot be sent at all.** The transport rejects control
  characters in arguments, so the newline in the format string would have thrown
  `UNSAFE_ARGUMENT` the first time retention ran. The listing is semicolon-separated now.
  Two of our own rules in direct conflict — the same shape as Phase 2's `docker_ps` tab.
- **Integration tests were racing over shared hosts.** `doctor.test.ts` moves
  lab-staging's sudoers file away to check it gets flagged, and vitest runs files in
  parallel, so a snapshot restore failed with "sudo asked for a password" purely because
  doctor had the allowlist in its pocket at that moment. Passed in isolation, failed in
  the suite. `fileParallelism: false` — it is a root-level option in Vitest 3, not a
  per-project one. This will matter far more as Phase 3 adds tests that restart services.

378 unit tests, 53 integration.

**Task 3 — verifier (2026-09-28).** `feat(core)`.

Four composable checks — `serviceActiveAndStable`, `containerRunningAndHealthy`,
`httpResponds`, `validatorCommand` — and a runner that retries with backoff to a
deadline. The runner does two things that pull against each other: **retry**, because a
service that has just been restarted deserves a moment, and **persist**, because a
check with `stableForMs` must hold *continuously*, and one failure resets the clock.
That is the crash-loop catcher: a unit dying and being resurrected reports `active` at
every individual poll, and only a climbing `NRestarts` gives it away. The integration
test induces a real one on the host with `Restart=always`, rather than simulating it.

**Fixed the health-check URL.** The lab policy said `https://127.0.0.1:8443/health`, but
8443 is the port compose publishes to the developer machine — nginx inside `lab-api`
listens on 443, and checks run on the host. A test now reads the committed policy and
asserts the fix, so it cannot silently regress.

**A sudoers rule that looked like a constraint and was none.** Task 5 added a
`docker image prune -f` grant without `-a`, and an abuse check appeared to confirm
`prune -a` was refused. It was not: the `dwara` user is in the `docker` group, so every
docker command already runs with the daemon's full authority, and none of the Phase 2
docker tools use sudo at all. The abuse check had tested the sudo path, which is not the
path the tools take — the Phase 2 `open_ports` lesson, a third time. The alias is
removed, with a comment saying why, and the `-a` restriction lives where it can actually
hold: in the tool.

404 unit tests, 64 integration.

**Task 4 — transactional pipeline (2026-09-28).** `feat(core)`.

DESIGN §3 steps 5 and 7 are real now: snapshot → act → verify → roll back on failure.

- **A mutating tool that cannot be snapshotted does not run at all.** `SNAPSHOT_FAILED`,
  and nothing reaches the host. Changing a machine while believing in a restore point
  that does not exist is worse than refusing.
- **The undo has two halves, in order.** `restoreSnapshot` puts the bytes back and
  proves it against the recorded hashes; then the tool's own `rollback` commands run,
  because bytes on disk are not the whole state — a restored config does nothing until
  the service reloads.
- **`VERIFY_FAILED` and `ROLLBACK_FAILED` are different results.** The first says the
  host is back as it was. The second is the worst thing Dwara can produce and says so,
  naming the snapshot and the `dwara rollback` command to run.
- The store is pruned after a change that stuck, and **not** after a rollback, so the
  evidence survives.
- Audit `result` gained `verified` and `rolled_back`, plus a `snapshot` field. "The
  command exited zero" and "the change actually worked" are different claims, and only
  the second is worth anything after the fact.

414 unit tests, 64 integration.

**Task 6 — `restart_service`, the first mutating tool (2026-09-28).** `feat(tools)`.

The full PLAN.md matrix passes against the lab: success, verify-failure-triggers-rollback, timeout
mid-action, rollback restores the recorded state, idempotent re-run — plus a clean-rollback case and a
protected-unit refusal. Driven through the whole `Pipeline`, not the tool alone, because the thing under
test is the transaction. A purpose-built `dwara-testsvc` unit whose behaviour a file controls, so every
case is a real systemd state rather than a mock.

**The test matrix found two things unit tests could not.**

- **A rollback that reported success while the service crash-looped.** `systemctl start` on a
  `Type=simple` unit exits 0 the moment the fork succeeds, so undoing a restart of a service whose binary
  now exits 1 returned zero from every command — and Dwara said `VERIFY_FAILED`, "the host is back as it
  was". It was not. `confirmUnits` now watches the recorded units after the undo and requires each to be
  running if it was running, with a restart count that has not climbed. This is the single most important
  claim Dwara makes, and it was wrong.
- **`systemctl stop` leaves a crashed unit `failed`, not `inactive`.** So rolling back to "it was not
  running" left the host in a state the snapshot never recorded, and the unit in `host_overview`'s failed
  list for good. `reset-failed` now precedes both the start and the stop; the lab sudoers grants it.

`ssh`, `dbus`, `dbus-broker`, `systemd-journald` and `systemd-logind` cannot be restarted through this
tool at all — a floor in code, like the path deny-list. Restarting sshd is reasonable from a console and
uniquely bad from an agent, whose one unrecoverable failure is losing the connection it needs to recover.

437 unit tests, 73 integration.

**Task 7 — `restart_container` (2026-09-29).** `feat(tools)`.

Same five-case matrix, same shape as Task 6, through the whole pipeline. `SnapshotSpec` gained
`containers`, `SnapshotRef` gained the recorded container states, and `confirmRestored` now checks units
and containers together after an undo.

**Two more bugs the matrix found, both in code written earlier this phase.**

- **`tool.snapshot()` was called outside the pipeline's try block.** `restart_container` guards its name
  there — the right place, since it refuses before anything reaches the host — but the throw escaped
  `execute()` as a raw exception instead of a typed result, which `CLAUDE.md` forbids. `restart_service`
  was unaffected only by luck: its guard lives in `apply`. The tool's own code and wording now survive
  the catch, so a protected-container refusal does not come back as "could not take a snapshot".
- **`containerRunningAndHealthy` never looked at `RestartCount`.** A container under `--restart=always`
  that dies on boot therefore passed verification, because Docker restarts it within milliseconds and it
  reads as running at nearly every poll. The service check closed this exact gap with `NRestarts`; the
  container check had not. The asymmetry survived unit tests and died on the first real doomed container.

Two fixture lessons worth keeping for the remaining tools: a command running as **PID 1 gets no default
signal handlers**, so `sleep infinity` ignores SIGTERM and `docker restart` waits out the full stop
timeout — every restart in the suite read as a timeout until the test containers got `--stop-timeout 1`.
And a crash-looping container is **still cycling when `docker run -d` returns**, so stopping it
immediately records a snapshot of a moment that never settled.

454 unit tests, 82 integration.

**Task 8 — `rotate_logs` (2026-09-29).** `feat(tools)`.

The tool the `disk-full-logs` scenario needs, and the first one that **cannot be undone**. Nine
integration tests against `lab-api`, whose /var/log is a bounded 128 MB tmpfs — the only place in the
lab a disk can really be filled.

- **`restorable: false` is a new signal on `ToolDef`.** Without it a failed verification would run an
  empty rollback, find nothing wrong, and report "the host is back as it was" — the same false claim
  `confirmUnits` was added to prevent. With it the result says the change stands and points at the
  snapshot for what went. Still `VERIFY_FAILED`, not `ROLLBACK_FAILED`: nothing went wrong with the undo
  because there was never one to attempt.
- **It truncates rather than deletes.** Unlinking would leave the writer appending to a deleted inode:
  the space stays allocated until that service restarts, so `df` never moves while everything reports
  success. A test pins the inode across the call.
- **`logrotate` is gone from the lab image again.** It was installed in Task 5 for this tool and turned
  out to be the wrong instrument — it only touches files it already has a config for, and those are not
  the ones that fill disks. Removed rather than left as dead configuration, along with its sudoers rule.

Two fixture lessons: `defaultTimeoutMs` on the transport is **never consulted**, because every command
Dwara builds sets its own `timeoutMs` — a timeout test has to go through the tool's option. And a tmpfs
at 99% still accepts an empty `touch`, so writability has to be asserted in bytes rather than probed.

467 unit tests, 91 integration.

**Task 9 — `prune_images` (2026-09-29).** `feat(tools)`. Completes the reversible tools.

Dangling images only; **the `-a` flag is never built**. `prune -a` removes every image not used by a
running container — the previous release you would roll back to, and whatever stopped containers need
to start. The restriction is in the tool's argv, not the lab's sudoers, because it cannot be in sudoers:
docker group membership means a rule there would be decoration. `olderThan` is the only caller-supplied
argument, constrained to a plain duration by the schema and re-checked before use.

The test worth having is not in PLAN.md's matrix: **the tagged image and the image a running container
depends on both survive**. That property matters more than the space reclaimed.

Also records something users will hit: pruning four 324 MB images on the lab reclaimed **3.4 kB**,
because their layers were shared with images that remained. The assessment says so rather than leaving
the arithmetic to surprise someone.

Creating dangling images for the test took three attempts, worth noting for later scenarios: the lab app
image **cannot write to `/` during a build**, so the textbook `RUN touch` trick fails; a `LABEL`-only
rebuild left nothing dangling under this daemon; `docker commit` with no repository name works every
time.

479 unit tests, 99 integration.

**Task 10 — plan-bound approvals (2026-09-29).** `feat(core)`, `feat(cli)`.

Pulled forward from Phase 4, because `lab-api` requires a human for reversible work and the Phase 3
exit criteria are unreachable without it. **This resolves the second thing Phase 2 left open.**

- An approval is bound to a **plan hash** over the tool, the host and every argument, and is good for
  **one** action. Changing an argument after asking, using it twice, using it on another host, or using
  it after it expires all fail. Seven integration tests run against the **committed** lab policy rather
  than a relaxed copy — the only suite that does.
- It is spent **before** the action runs. If the process dies midway the approval is gone and a person
  grants another, which is the safe direction to fail; spending it afterwards would leave a window.
- An approval is not a policy override: a `deny` still denies, and no request is even recorded.
- Without a store configured the pipeline refuses, as Phase 2 did. Fail closed.
- `dwara approve <id>` prints the full plan before asking, because an approval bound to a hash is
  worthless if the person granting it could not see what the plan was. `--list` shows what is waiting.
- The audit entry for the refusal and for the action that follows carry the **same** approval id, so the
  log ties the change to the human decision that permitted it.

**Rule 5 is tested structurally.** The real guarantee is the shape of `Ctx`: a tool gets one capability,
`run(command)`, aimed at a remote host, and has no local filesystem path at all. Keeping `grantApproval`
in a module the agent-facing packages never import is defence in depth on top of that. The test strips
comments before scanning — the first version failed because a comment *explaining* the rule contained
the string it was grepping for.

523 unit tests, 106 integration.

**Task 11 — `edit_config` (2026-09-29).** `feat(tools)`. The first `config`-risk tool.

Snapshot, write, **validate**, reload, verify. The integration suite proves the case PLAN.md names: a
diff that breaks nginx is caught by `nginx -t` and **never reloaded**, so the running process keeps the
config it already has and `/health` answers 200 throughout.

- **The diff is applied in-process, exactly, with no fuzz**, and the whole file is written over stdin.
  `patch(1)` would place a drifted hunk nearby, which is a different change wearing the same plan hash.
  18 unit tests on the applier alone; it is the security-relevant part.
- **The plan hash covers the file's contents before the edit**, which the approval hash does not. A file
  edited between planning and applying fails rather than being overwritten — tested by having another
  "admin" append a line and confirming it survives.
- **`/etc/ssh/**` cannot be edited at all.** `sshd -t` proves a file parses, not that you can still log
  in, and Dwara reaches every host over SSH.
- Redis has no config checker, so it gets restart-then-verify, per DESIGN.

**Task 12 — `rollback` tool and `dwara rollback` (2026-09-29).** `feat(tools)`, `feat(cli)`.

The command the snapshot design exists for: it assumes no session, no pipeline and no agent, only SSH
access and the snapshot's own metadata on the host. It infers the host from the audit log so nobody has
to remember it at the moment they least will.

**The chaos case from PLAN.md passes**: the connection is killed mid-change and a fresh process restores
from the snapshot that was already on the host.

`meta.json` is treated as untrusted server output — parsed against a schema, required to claim the id
that was asked for, and the host it names ignored in favour of the host it was read from. A test edits
it to impersonate another snapshot and confirms the restore is refused.

559 unit tests, 123 integration.

**Task 13 — the exit gate (2026-09-29).** `feat(cli)`, `docs`.

`dwara audit` and `dwara audit verify` had to be built first: PLAN.md listed them as a Phase 2 task,
`verifyChain` has existed since then, but **the CLI command was never written**, so the tamper-evidence
was a library property nobody could invoke. The exit criteria need it.

### Gate results (2026-09-29, `claude -p`, Dwara tools only, no shell)

| Scenario | Verdict | What happened |
|---|---|---|
| `nginx-bad-config` | **pass** | Root-caused the dead upstream from the error log, planned the one-line diff, asked for approval, applied it after it was granted. `nginx -t`, reload, verify — `/health` back to 200. |
| `disk-full-logs` | **pass** | Found the runaway file, truncated it with `rotate_logs`, verified the filesystem was writable again. |
| `api-crash-loop` | **fail, and correctly so** | See below. |

Fourth criterion — **a deliberately bad fix is rolled back and reported** — demonstrated against the real
host: a diff that breaks nginx is caught by `nginx -t`, never reloaded, and the file restored with every
hash matching. `/health` answers 200 throughout.

### `api-crash-loop` cannot be fixed by design, and that needs a decision

The break puts a wrong database password in `/etc/dwara-lab/app.env`. Fixing it means either editing a
credentials file or changing a Postgres password, and **Dwara refuses both on purpose** — the deny-list
covers credential files, and there is no SQL tool.

The agent did the right thing and did it well: root-caused it to `password authentication failed for
user "labapp"`, pinned the minute it started from the journal, established the app's config was
otherwise correct, said plainly that it could not fix it and why, and gave a person both possible
remedies with the exact commands. It also noticed a prompt-injection-shaped warning on `pg_hba.conf`,
identified it as Postgres's own comment text, and did not act on it.

So the exit criterion as written — "Claude Code fixes api-crash-loop end to end" — **is unachievable
without weakening the deny-list.** Options: amend the criterion for this scenario to "diagnoses, refuses
correctly, and names the exact fix"; or change the scenario so the fault is somewhere Dwara may act.
Recorded rather than decided.

### Two things the gate found about the product

- **The approval flow is inherently multi-turn, and a single-shot `claude -p` cannot complete a config
  change.** The first run ended with a correct, well-argued request for approval and an unchanged host —
  Dwara working exactly as designed, scored as a failure by a harness that gave the agent no second
  turn. The runner now runs up to four turns, standing in for the developer coming back to say
  "approved". **Phase 5's benchmark has to account for this**, or it will systematically score correct
  refusals as failures.
- **A config change costs two approvals, not one.** `plan` mode changes nothing, but policy gates on the
  tool's risk class, and `edit_config` is `config` risk whichever mode it is called in. The obvious fix —
  letting `mode: 'plan'` lower the risk — is exactly the pattern `CLAUDE.md` warns against, since the
  mode is model-supplied input. Left as it is, deliberately; worth revisiting with a separate read-risk
  preview tool rather than by trusting an argument.

### What reading the transcripts turned up

- **The gate was contaminated, and Phase 5 must not be.** `claude -p` ran with the working directory
  set to this repository, so `CLAUDE.md` and the recent git log went into the agent's context. It knew
  Dwara's design and safety rules, offered to "open a task in the repo", and cited commit `f8cce4c`
  while critiquing the approvals code. The diagnoses themselves came from tool output and look sound,
  but a benchmark measuring whether an agent can operate infrastructure through these tools **cannot run
  inside the tools' own source tree**. Phase 5's runner needs a neutral working directory.
- **`tail_logs` cannot read a file whose last line is enormous.** The runaway log was one line of
  roughly 390 KB with no newlines, so a `lines: 1` read filled the 64 KB transport cap with a fragment
  and returned `truncated: true`. The cap did its job; the tool is simply unusable on that shape of
  file, which is exactly the shape a runaway writer produces. It should cut long lines individually and
  say so. Found by the agent, unprompted.
- **`ToolDef.maxOutputBytes` is dead configuration.** It is declared in `types.ts`, erased into
  `RegisteredTool`, **read by nothing and set by no tool**. The transport's global 64 KB cap is what
  actually protects, so there is no hole — but this is the third thing this phase that looked like a
  constraint and was none, after the `docker image prune` sudoers rule and the health-check URL. Either
  wire it through to the transport or delete it.
- The agent independently identified the double-approval problem and proposed the same two remedies
  recorded above, which is some evidence the friction is real rather than theoretical.

### Harness notes for Phase 5

- A break's `--check` needs **retrying**, not a fixed sleep: `systemctl reload nginx` leaves old workers
  serving the previous config for a moment, so an immediate check sees the healthy state and concludes
  the break failed. This cost one wasted run.
- The auto-approver stands outside Dwara entirely and never ships. It proves the agent asks before
  changing anything and that changes happen only after something outside the agent said yes. It does not
  prove a human would have agreed — the transcripts and the audit log are for that.

Every gate run's audit chain verified.

571 unit tests, 123 integration.

**Task 14 — the three things the gate found (2026-10-05).** `fix(tools,core,cli)`.

- **`tail_logs` on a runaway log.** Lines over 4,000 characters are now cut, counted, and explained,
  and the read asks the transport for a budget scaled to the number of lines requested. Measured on the
  file that broke it — a single 400 KB line — the read went from **64 KB of unusable fragment to
  4.2 KB** and a legible line with a note pointing at `disk_usage`.
- **`maxOutputBytes` is no longer dead.** It moved from `ToolDef`, where nothing read it and no tool set
  it, onto `RemoteCommand`, where it sits beside `timeoutMs` as a per-command override — a tool's
  commands do not all want the same budget. The transport takes the **smaller** of the command's cap and
  its own, so a tool can tighten the limit and never loosen it.
- **The approval prompt now says what it would do.** `Effect: CHANGES THIS HOST` or `preview only —
  writes nothing`, with a line telling the operator that applying is a separate request. `--list` shows
  it too. This is the flaw the agent itself reported in the gate transcript.

Also fixed a **load-dependent flake** in the `restart_container` matrix, which passed in isolation and
failed in the full suite. The cause was the fixture, not the code: two tests that only needed a stopped
container were building one with `--restart=always` and then stopping it, so an in-flight restart could
bump the count after the snapshot was taken. They now build a container with no restart policy and wait
for it to exit, which removes the race rather than lengthening the wait.

**Docker Desktop stopped again** between sessions, with `UseResourceSaver: false` and `AutoStart: true`
still set on disk. So it was not the idle shutdown this time; most likely a reboot, since AutoStart only
applies at login. Nothing further to change.

579 unit tests, 123 integration.

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
