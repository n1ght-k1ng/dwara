# Dwara

**Policy-controlled SSH access for AI coding agents.**

Named after the _Dwarapala_ — the guardians carved at the doors of Indian temples.
Sanskrit for "door". Pronounced DWAH-rah.

Give an agent a shell on your servers and it will eventually do something you did
not sanction: restart the wrong service, truncate the wrong log, follow an
instruction it read in a log file. Dwara sits between the agent and the hosts and
makes that structurally difficult rather than merely discouraged.

> **Status: pre-1.0, nothing published yet.** Phases 0–6 of `docs/PLAN.md` are
> complete: the tools, policy engine, approvals, hook, benchmark and security work.
> It runs against a Dockerised lab today. It has not yet been run against real
> infrastructure, and the benchmark's headline comparison has been built but not
> paid for. Both are deliberate and both are tracked in `docs/PROGRESS.md`.

---

## The one idea

**The model is untrusted.** Not "usually sensible" — untrusted, in the same sense
as a form submission from the internet. It may be prompt-injected by a log line, a
config comment, a container name or a file name it was asked to read.

So every guarantee lives in code: schemas, a policy engine, a hook, a verifier. No
guarantee rests on a tool description, on the model behaving, or on anyone having
asked it nicely.

## What that looks like in practice

**Typed tools, and no shell.** Seventeen tools, each with a zod schema, named by
risk class so a client can allow a whole category: `read_host_overview`,
`reversible_restart_service`, `config_edit_config`. There is no `run_command` and
there will not be one — that is the first rule in `CLAUDE.md`.

**Commands are argv arrays.** Every element is escaped individually before it
reaches a remote shell. Nothing is ever built by string concatenation, which is
property-tested against arbitrary bytes and against every tool's inputs.

**Policy decides, not the model.** Per host and per risk class, with precedence
`deny > require_approval > allow`. Overrides may tighten anything and may never
loosen `deny` or `never`. The `destructive` class is refused in code before host
rules are consulted.

**Changes are transactional.** Snapshot, act, verify the postconditions, and
automatically roll back if they do not hold. "The command exited zero" and "the
change worked" are different claims, and only the second is reported as success.

**A human approves, and the agent cannot.** Approvals are bound to a plan hash
covering the tool, the host and every argument; single-use, short-lived, and
claimed atomically. Fourteen routes by which an agent might approve its own action
are enumerated in `docs/THREAT_MODEL.md`, each with the test that closes it.

**Server output is data, never instructions.** Every result is wrapped in an
envelope marked untrusted, with six detectors flagging text that reads as an
instruction — including zero-width characters and ANSI escapes, which hide text
from the human reading the same output.

**Everything is logged, including refusals.** A hash-chained `audit.jsonl`, so
tampering is detectable. `dwara audit verify` checks the chain end to end.

**Raw SSH is blocked.** A `PreToolUse` hook catches an agent reaching for `ssh`
directly, with a 67-case evasion corpus and zero false negatives. It is defence in
depth, not a boundary — the boundary is a dedicated key, and
`docs/DEDICATED_KEY.md` explains why.

### Two things it refuses outright

No policy loosens either, because in both cases the damage is not bounded by the
edit, so an approval would not be a meaningful control:

- **`/etc/ssh`** — `sshd -t` proves a file parses, not that you can still log in,
  and Dwara reaches every host over SSH.
- **`/etc/systemd`** — a unit file _is_ an arbitrary command run as root, and
  starting a unit is an ordinary permitted action.

Both can still be read, so a diagnosis can tell you exactly which line to change.

## Try it against the lab

No real servers involved: the testbed is five Docker containers running systemd,
sshd and a small application stack.

```bash
pnpm install
pnpm build
pnpm testbed:up          # five lab hosts, ~6 GB of images
pnpm dwara doctor --ssh-config testbed/ssh_config --policy testbed/policy.yaml
```

Then break something and point an agent at it:

```bash
pnpm testbed:break nginx-bad-config
```

Register the MCP server with your client — `pnpm dwara init` does this for Claude
Code and prints snippets for other clients — and ask it why the API is returning
502s. It will diagnose through read tools, and stop and ask you before it changes
anything.

```bash
pnpm dwara approve           # read what it wants to do, then allow it once
pnpm dwara audit verify      # check the hash chain end to end
pnpm dwara rollback          # put a host back, without the agent involved
```

## The benchmark

`BENCHMARK.md`. Twenty-one scenarios on the lab — 12 to fix, 5 with a prompt
injection planted where tool output actually comes from, 4 that **cannot** be
fixed and where the correct outcome is an honest handover.

Two things about the methodology are worth knowing before reading any number from
it:

- **Runs are scored from the audit log, not the transcript.** What an agent did and
  what it says it did are different claims. An early run produced a careful,
  accurate-sounding account of a fix before the fix had been applied.
- **Every scenario is validated without a model.** Break it, apply the repair a
  competent operator would make, confirm the check agrees. That is free, and a
  wrong `check.sh` would otherwise show up as an agent failure and be reported as
  a finding.

The benchmark's job is to find things, and so far it has mostly found them in Dwara
rather than in the models — see the findings register in `docs/THREAT_MODEL.md`.

## Where to read next

|                                     |                                                                                                                               |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `docs/DESIGN.md`                    | architecture, the tool pipeline, and a dated decision log                                                                     |
| `docs/THREAT_MODEL.md`              | assets, trust boundaries, five attacker models, findings register, and the limitations that are conceded rather than defended |
| `docs/FIRST_REAL_HOST.md`           | the order to do things the first time you point it at a machine that matters                                                  |
| `docs/DEDICATED_KEY.md`             | the key and sudoers setup, and how to read an allow-list as a whole                                                           |
| `BENCHMARK.md`                      | the scenarios, the methodology, and what a run costs                                                                          |
| `SECURITY.md`                       | what is in scope, what is not, and how to report something                                                                    |
| `docs/PLAN.md` · `docs/PROGRESS.md` | the phase plan, and an honest running log of what broke                                                                       |

## Stack

TypeScript (strict), Node 20+, ESM, pnpm workspaces. zod for every schema, the
official MCP SDK over stdio, `execa` calling the system `ssh` binary rather than
reimplementing SSH, Vitest, Docker Compose for the lab.

## Licence

Apache-2.0.
