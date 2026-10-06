# Pointing Dwara at a real host for the first time

`docs/PLAN.md` Phase 7. The lab proves the mechanisms work; a real machine proves
they are usable, and it is the first time a mistake costs something.

The order below is deliberate and is the order `PLAN.md` sets out: **your own
machine, then a machine someone lent you, then anything belonging to a company** —
and the last of those only with explicit approval from the company, not merely from
whoever happens to have the SSH key. Start non-production. Start read-only.

---

## 1. Read-only means `deny`, not `require_approval`

The temptation is to set the mutating classes to `require_approval` and rely on
yourself to say no. Don't, not for the first few days. An approval prompt is a thing
a tired person clicks at the end of a long session; a `deny` is not.

`.dwara/policy.yaml` — gitignored, and nothing in it belongs in a commit:

```yaml
version: 1

defaults:
  allow: [read]
  deny: [reversible, config, destructive]

hosts:
  - match: 'my-host'
    tags: [production]
    allow: [read]
    deny: [reversible, config, destructive]

tools:
  # Belt and braces: the risk-class deny already covers these, and naming them
  # means a later edit to `defaults` cannot quietly re-enable one.
  never:
    - restart_service
    - restart_container
    - rotate_logs
    - prune_images
    - edit_config
    - rollback
  overrides: {}

limits:
  max_actions_per_session: 60
  max_hosts_per_action: 1
```

Widening this later should be a separate, deliberate act with a line in
`docs/PROGRESS.md` saying what you learned that justified it.

## 2. A key that only Dwara can use

The full reasoning is in `docs/DEDICATED_KEY.md`; the short version is that every
other guarantee Dwara offers is enforced inside Dwara's own process, so anything
that reaches the host another way is not covered by any of it.

```bash
mkdir -p ~/.dwara/keys && chmod 700 ~/.dwara/keys
ssh-keygen -t ed25519 -N '' -C 'dwara' -f ~/.dwara/keys/dwara
chmod 600 ~/.dwara/keys/dwara
```

No passphrase, because Dwara runs `ssh` with `BatchMode=yes` and will never prompt —
a passphrase would mean an `ssh-agent`, and anything running as you can use an
agent. **Do not add this key to the agent.** That is the point of it.

`~/.dwara/ssh_config`:

```
Host my-host
  HostName <address>
  User <account>
  IdentityFile ~/.dwara/keys/dwara
  IdentitiesOnly yes
  BatchMode yes
  PasswordAuthentication no
  StrictHostKeyChecking yes
  UserKnownHostsFile ~/.dwara/keys/known_hosts
  ConnectTimeout 5
```

`IdentitiesOnly yes` is load-bearing. Without it `ssh` offers every key it can find,
including your ordinary one, and the restriction will appear to work while not
working.

On the host, narrow the key in `authorized_keys`:

```
restrict,pty ssh-ed25519 AAAA... dwara
```

## 3. Check the thing nobody checks

The useful test is not whether Dwara can connect. It is whether a **plain shell**
can:

```bash
ssh -F ~/.dwara/ssh_config my-host true   # must succeed
ssh my-host true                          # must FAIL
```

If the second succeeds, your everyday credentials still reach the host, every guard
in Dwara is one Bash call away from being bypassed, and the hook is all that stands
there. Either remove your ordinary key from that host's `authorized_keys`, or accept
that and write it down.

## 4. Then `doctor`, before any agent

```bash
pnpm dwara doctor --ssh-config ~/.dwara/ssh_config --policy .dwara/policy.yaml
```

`doctor` reports reachability, which commands `sudo -n` will actually run, and
whether the policy makes sense for the hosts it found. Where a command is not
permitted it prints the exact `sudoers` line to add. Expect to iterate here a few
times — this is where a real machine differs most from the lab, because the lab's
allow-list was written alongside the tools and yours was not.

Read the allow-list **as a whole** before pasting anything into it.
`docs/DEDICATED_KEY.md` has the two traps worth knowing: a `tee` into a directory of
systemd units composes with permission to start units into full root, and a trailing
wildcard on a `find` rule permits arbitrary execution.

## 5. Only then, an agent — and only questions

For the first few days ask it to explain, not to act. The policy above makes that the
only option anyway, which is the idea: you find out what the read tools are like to
use before anything can change.

Worth noticing and writing down:

- Which tool it reaches for first, and whether that was the useful one.
- Where it had to guess because no tool could tell it something. A missing read tool
  shows up as an agent hedging, not as an error. The benchmark found exactly this:
  `disk_usage` could not name a file, so `rotate_logs` was unreachable, and the agent
  correctly refused to guess at a filename.
- Anything it says it did, that it did not do. The audit log is the record;
  `pnpm dwara audit` reads it and `pnpm dwara audit verify` checks the chain.
- Whether a refusal told it enough to do something else, or just stopped it.

`PLAN.md` asks for this as a daily log in `docs/PROGRESS.md`: what you asked, what
worked, what was clumsy.

## 6. What never leaves the machine

For anything that is not yours personally, and as a habit for things that are:
**no hostnames, IP addresses, configuration, log content or screenshots in the
repository, the benchmark, the docs or a demo.** `.dwara/` is gitignored for this
reason, and the dogfooding log should describe shapes — "a service with a
misconfigured upstream" — rather than identities.

The redactor runs on all tool output and will catch credentials in the shapes it
knows, but it is a safety net under your judgement, not a substitute for it. Two
known gaps are written down in `docs/THREAT_MODEL.md`.
