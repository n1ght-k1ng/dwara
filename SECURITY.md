# Security policy

Dwara gives an untrusted model policy-controlled access to real servers. A bug
here is not a crash — it is a change nobody approved, or a credential in a
transcript. Reports are welcome and taken seriously.

## Reporting a vulnerability

**Do not open a public issue.** Use GitHub's private vulnerability reporting
("Report a vulnerability" on the Security tab), which reaches the maintainers
without disclosing anything.

Please include enough to reproduce: the policy file (redacted), the tool call or
argument involved, what you expected the guard to do, and what it did instead. A
failing test is the most useful form a report can take.

**What to expect:** acknowledgement within 3 working days, an assessment within 10,
and a fix or a documented decision before any public detail. If a report turns out
to describe a limitation already stated in `docs/THREAT_MODEL.md`, that will be
said plainly rather than treated as a non-issue — if it was worth reporting, the
documentation was not clear enough.

Credit is given unless you ask otherwise.

## Scope

**In scope — these are the guarantees Dwara claims:**

- An argument reaching a shell as syntax rather than as data. Commands are `argv`
  arrays, escaped per element; anything that defeats that is the most serious class
  of bug in this project.
- Reading or writing a path on the deny-list (`/etc/shadow`, `/etc/sudoers*`,
  private keys, `**/.env`, `.pgpass`, `.netrc`, shell history, `/root`), by any
  spelling, including traversal and symlinks.
- Any route by which the agent approves its own action. Fourteen known routes and
  their controls are in `docs/THREAT_MODEL.md`; a fifteenth is a vulnerability.
- Applying a change that differs from the plan a human approved, reusing an
  approval, or spending one twice.
- A mutating tool that changes a host without a snapshot, or reports success when
  verification failed.
- Secrets surviving the redactor into tool output, the audit log or an error.
- Policy precedence being violated: anything that loosens `deny`, `never`, or the
  `destructive` class.
- The PreToolUse hook failing _open_ on a command that reaches a managed host.

**Out of scope — stated so a report is not wasted:**

- **A model acting on an injected instruction.** Server output is wrapped as data
  and suspicious patterns are flagged, but whether the model obeys them is a
  property of the model. This is measured by the `injection-*` benchmark scenarios
  rather than guaranteed. A way to make the _envelope_ itself misleading is in
  scope.
- **The hook being bypassed by an unparseable command**, such as `bash ./deploy.sh`.
  It is defence in depth by design; `docs/DEDICATED_KEY.md` is the control. A
  bypass of a command shape the hook _claims_ to detect is in scope.
- **A local attacker with write access to `.dwara/` or the SSH key.** Conceded:
  they have already won. The audit chain is tamper-_evident_, not tamper-proof.
- **An operator approving something harmful**, or merging a policy change that
  widens access. `policy_hash` in every audit entry makes it attributable.
- **A sudoers allow-list that grants too much.** Yours to review; the traps we know
  of are documented in `docs/DEDICATED_KEY.md`. A rule _Dwara's own guide
  recommends_ that turns out to be too wide is very much in scope.
- Denial of service against your own hosts via Dwara's rate limits.

## Supported versions

Pre-1.0. Only the latest release gets fixes; there are no maintained branches yet.
This section gets a table when there is something to put in it.

## The dependency surface

Deliberately small, because every runtime dependency is code that runs beside your
SSH key.

| Runtime dependency          | Why                                                                                 |
| --------------------------- | ----------------------------------------------------------------------------------- |
| `@modelcontextprotocol/sdk` | the MCP protocol itself                                                             |
| `execa`                     | process spawning; Dwara calls the system `ssh` rather than reimplementing SSH       |
| `shell-quote`               | _parsing_ commands in the hook. Not used for escaping — see `ssh/escape.ts` for why |
| `commander`                 | CLI argument parsing                                                                |
| `yaml`                      | reading the policy file                                                             |
| `zod`                       | schemas, which are the first thing every tool call meets                            |

`pnpm audit --prod` reports no known vulnerabilities. The lockfile is committed
and `pnpm.overrides` pins two transitive build-tool packages to patched versions;
`pnpm audit` is clean including dev dependencies.

Releases are published with npm provenance, so the published artifact is
attestably built from this repository.

## What is enforced in code, not configuration

No policy, flag or override loosens any of these. They are the floor:

- There is no shell tool, and `CLAUDE.md` forbids adding one.
- The `destructive` risk class is denied, checked before host rules or overrides.
- `/etc/ssh` cannot be edited: `sshd -t` proves a file parses, not that you can
  still log in, and Dwara reaches every host over SSH.
- The path deny-list lives in code.
- `sudo` is only ever `sudo -n`. Dwara never prompts for or stores a password.
- SSH always runs with `BatchMode=yes`.
- No MCP tool can create or modify an approval.
