# Contributing to Dwara

Dwara is a safety layer. A bug here is not a crash — it is a change nobody
sanctioned on a real server, or a credential in a transcript. That shapes how
contributions are reviewed, and it is worth knowing before you start.

## Before a pull request

**Agree to the CLA.** Put `I have read CLA.md and I agree to it.` in the
description of your first pull request. [`CLA.md`](CLA.md) explains why: the
project is AGPL-3.0-or-later, and keeping the option of a separate commercial
licence requires the right to relicense contributed code. One agreement covers
everything you send afterwards.

**Run the checks.** The same ones CI runs:

```bash
pnpm install
pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

Integration tests need the lab: `pnpm testbed:up`, then
`DWARA_TESTBED=1 pnpm test:integration`. It is about 6 GB of images.

## The rules that are not negotiable

These are in [`CLAUDE.md`](CLAUDE.md) and they are not style preferences — each one
exists because its absence is a vulnerability:

- **Never build a remote command by string concatenation.** Tools return `argv`
  arrays and the transport escapes each element. A pull request that interpolates
  anything into a shell string will be declined.
- **No arbitrary shell tool.** No `run_command`, not even for debugging.
- **Every mutating tool defines `snapshot`, `verify` and `rollback`**, with
  integration tests for success, verify-failure-triggers-rollback, and timeout.
- **Policy precedence is deny > require_approval > allow**, and an override can
  never loosen `never` or `deny`.
- **No tool may grant an approval.** The agent cannot approve its own action;
  [`docs/THREAT_MODEL.md`](docs/THREAT_MODEL.md) lists fourteen routes and the test
  that closes each.
- **All tool output passes through the redactor**, and server output is wrapped as
  untrusted data.
- `sudo` is only ever `sudo -n`. SSH always uses `BatchMode=yes`.
- **Never commit real hostnames, addresses, configuration or credentials.** Testbed
  names only.

## What makes a contribution easy to accept

**Measure, do not assume.** Capture the real output of a command before writing a
parser for it. Most bugs found in this project were cases where the tested path was
not the path the tool takes — a sudoers rule for a command the tool never ran, a
`du` flag that listed directories when the tool needed file names.

**A benchmark scenario is the most welcome contribution there is.** It is the asset
nothing else replaces. See [`BENCHMARK.md`](BENCHMARK.md) for the format;
`evals/scenarios/validate.sh` checks your scenario end to end without spending
anything on a model, and a scenario that has not passed it is not ready.

**Say what you are unsure about.** A pull request that names its own weak point is
reviewed faster than one that hides it.

## Reporting a security issue

Not here. See [`SECURITY.md`](SECURITY.md) — use private vulnerability reporting
rather than a public issue.
