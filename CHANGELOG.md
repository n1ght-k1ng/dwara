# Changelog

Notable changes to the published `dwara` package. Dates are the release date.

## 0.1.0 — 2026-10-26

First public release. Everything below has been exercised against the Docker
testbed; see **Known limitations**, which is the part worth reading first.

### What it does

**17 typed tools** over SSH — 11 read, 4 reversible, 2 config — reached through
an MCP server (`dwara-mcp`) that any MCP client can launch. There is no shell
tool and there will not be one: a tool returns an `argv` array and the transport
escapes each element, so no remote command is ever built by string
concatenation.

**A policy engine** that decides per host and per risk class, with precedence
`deny > require_approval > allow`. A host no rule matches is denied, so a
missing policy fails closed. Overrides may tighten and never loosen.

**Transactional mutation.** Every tool that changes something takes a snapshot,
acts, verifies the change did what it claimed, and rolls back automatically when
verification fails. `dwara rollback` undoes a change afterwards from the
snapshot.

**Approvals the agent cannot grant itself.** Plan-bound, single-use and
expiring, claimed atomically, granted only through the `dwara approve` CLI. No
MCP tool can issue one; `docs/THREAT_MODEL.md` lists the routes that were closed
and the test that holds each shut.

**A hash-chained audit log** of every call including refusals, verified with
`dwara audit --verify`. It records inputs and outcomes and never tool output,
which would otherwise be a second unredacted copy of everything the redactor
exists to protect.

**A redactor** on everything returned to the client, and an untrusted-data
envelope around server output with flags for content that reads as instructions
rather than as description.

**A PreToolUse hook** (`dwara-hook`) that stops the agent shelling out to `ssh`
and going around all of the above. Defence in depth, not a sandbox.

**A Claude Code plugin**, bundled into the same package: slash commands, a
skill, `hooks.json`, and permission settings.

**`dwara doctor`**, which reports reachability, which commands `sudo -n` will
actually run, and whether the policy covers the hosts it found — including an
AWS SSM preflight, because every SSM misconfiguration otherwise arrives as the
same unhelpful SSH timeout.

### Known limitations

- **No benchmark results are published yet.** `BENCHMARK.md` carries the full
  methodology and 21 validated scenarios; the matrix has not been run, so there
  are no headline numbers to cite.
- **The destructive risk class is denied outright.** Not configurable in this
  release.
- **`/etc/ssh/**` and `/etc/systemd/**` cannot be edited.** A unit file is an
  arbitrary command run as root, and starting a unit is an ordinary permitted
  action, so permitting the edit would be equivalent to granting root.
- **Injection resistance is a property of the model, not of this code.** The
  envelope flags and the typed tools narrow the blast radius; they do not make
  an agent immune to being talked into something inside its permissions.
- **Tested against containers.** systemd in Docker is close enough for service
  management, log growth and config errors, and not close enough for kernel
  issues, real disk pressure or hardware faults.
