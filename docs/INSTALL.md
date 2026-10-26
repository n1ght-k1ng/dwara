# Installing Dwara

## The thing to understand first

**Dwara is installed in exactly one place: the machine you work from.** Nothing is
installed on the servers it manages. No agent, no daemon, nothing scheduled.

A managed server needs two things added to it — a key in `authorized_keys` and a
`sudoers` line — and that is the whole footprint. Revoking Dwara is deleting one
line.

```
YOUR MACHINE                                    YOUR SERVERS
(everything is installed here)                  (nothing is installed here)

  MCP client (Claude Code, etc.)
        |
        | MCP over stdio
        v
  dwara-mcp ..... the 17 typed tools
        |
        +-- policy.yaml ...... what is allowed, per host
        +-- audit.jsonl ...... hash-chained log of every call
        +-- approvals/ ....... short-lived, single-use
        +-- keys/dwara ....... the only credential for these hosts
        |
        | ssh -F ~/.dwara/ssh_config
        | BatchMode=yes, ControlMaster=auto
        v
  system ssh binary  ------------------------->  sshd
                                                   |
  dwara-hook                                       +-- an account
  (blocks the agent from                           +-- authorized_keys: one line
   shelling out to ssh                             +-- sudoers.d/dwara: an
   directly)                                           allow-list of read commands
```

Three binaries, one package:

| | |
|---|---|
| `dwara` | the CLI: `init`, `doctor`, `approve`, `audit`, `rollback` |
| `dwara-mcp` | the MCP server your client launches |
| `dwara-hook` | the PreToolUse hook that blocks raw `ssh` |

## Prerequisites

What you need depends on what you are trying to do, so the list is split three
ways rather than given as one wall. **`dwara doctor` checks everything on the
server side for you and prints the exact fix for anything missing** — so this
section covers only what has to be in place *before* you can connect at all, which
is the part no command can check for you.

**Just to try the lab:**

- **Node 20+**
- **pnpm** — every command below is `pnpm …`; install with `npm install -g pnpm` or
  `corepack enable`
- **Docker** (with Compose) — the lab is five containers, about 6 GB of images
- while Dwara is clone-only (nothing on npm yet), also **git**

**To point it at a real server**, instead of Docker:

- **Node 20+**, **pnpm**, **git** as above
- the system **`ssh`** binary — Dwara calls it rather than reimplementing SSH,
  which is why your existing SSH config, agents and bastions all keep working

**To let it find your AWS machines** (`dwara discover`, or any SSM-reached host):

- the **AWS CLI v2**
- the **Session Manager plugin** (only for SSM-reached hosts)
- a working AWS login — a profile in `~/.aws`, an `aws sso login`, or an instance
  role. The rule is simply: **if `aws ec2 describe-instances` works in your
  terminal, Dwara's AWS features work.** You never hand Dwara an AWS key; it uses
  the access your `aws` command already has, and read-only access is enough.

> Once the npm package ships, pnpm and git drop off this list and installing is
> just Node plus the `ssh` binary. Until then it is from a clone.

## Step 1: install it on your machine

Nothing is published to npm yet, so from a clone:

```bash
git clone <repo> && cd dwara
pnpm install
pnpm build
pnpm dwara --version
```

## Step 2: a key that only Dwara uses

```bash
mkdir -p ~/.dwara/keys && chmod 700 ~/.dwara/keys
ssh-keygen -t ed25519 -N '' -C 'dwara' -f ~/.dwara/keys/dwara
chmod 600 ~/.dwara/keys/dwara
```

No passphrase, because Dwara runs `ssh` with `BatchMode=yes` and will never prompt.
A passphrase would mean an `ssh-agent`, and anything running as you can reach an
agent — including the agent you are trying to constrain. **Do not add this key to
`ssh-agent`.** That is the point of it.

Full reasoning in [`DEDICATED_KEY.md`](DEDICATED_KEY.md).

## Step 3: tell it how to reach each host

This is the only part that differs between environments, and the four cases below
cover almost everything. **Everything else in this document is identical regardless
of which one you are in** — same install, same key, same policy, same verification.

Dwara reads an ordinary SSH config, so if `ssh -F ~/.dwara/ssh_config <host>` works,
Dwara works.

> **On AWS? Let Dwara write this for you.** `dwara discover` asks AWS for your
> running instances and writes the SSH config — picking a direct connection or
> SSM per host, inferring the login from the OS, and naming the key pair to use.
> It only reads AWS and writes one local file; it uses the access your `aws`
> command already has, so `AWS_PROFILE=prod dwara discover --dry-run` shows you
> what it would write before anything is saved. Hosts it cannot reach are listed
> with the reason rather than dropped. The cases below are what it generates, and
> what to write by hand when you are not on AWS.

### A. The local lab — start here

Five Docker containers running systemd and sshd. No real servers, nothing to break,
and it is how every scenario in the benchmark is validated.

```bash
pnpm testbed:up
pnpm dwara doctor --ssh-config testbed/ssh_config --policy testbed/policy.yaml
```

The config is already written for you. Worth half an hour before touching anything
real, because it shows you what the tools return and what a refusal looks like.

### B. A host with an open SSH port — the simple real case

A personal VPS, a box on your LAN, anything you can already `ssh` to.

```
# ~/.dwara/ssh_config
Host my-vps
  HostName 203.0.113.10
  User dwara
  IdentityFile ~/.dwara/keys/dwara
  IdentitiesOnly yes
  BatchMode yes
  PasswordAuthentication no
  StrictHostKeyChecking yes
  UserKnownHostsFile ~/.dwara/keys/known_hosts
  ConnectTimeout 5
```

`IdentitiesOnly yes` is load-bearing. Without it `ssh` offers every key it can find,
including your ordinary one, and the restriction appears to work while not working.

### C. Behind a bastion

Add one line. Dwara needs no knowledge of it.

```
Host private-app
  HostName 10.0.1.25
  User dwara
  IdentityFile ~/.dwara/keys/dwara
  IdentitiesOnly yes
  BatchMode yes
  ProxyJump bastion
```

### D. No inbound port at all — AWS SSM

For hosts with no public IP and no port-22 ingress. Nothing needs opening.

Needs the AWS CLI, the Session Manager plugin, and `ssm:StartSession` on the target.

```
Host app-a
  HostName i-0123456789abcdef0
  User dwara
  IdentityFile ~/.dwara/keys/dwara
  IdentitiesOnly yes
  BatchMode yes
  ControlMaster auto
  ControlPersist 300
  ProxyCommand sh -c "aws ssm start-session --target %h \
      --document-name AWS-StartSSHSession --parameters portNumber=%p"
```

Two things about this one.

**`ControlMaster` is not optional here.** Without it every tool call pays a fresh
SSM handshake of a second or two. With it, one session is reused across the whole
investigation. It is the difference between usable and unusable.

**Do not use instance ids as aliases if the hosts autoscale.** Policy matches on the
alias, and an ASG refresh changes every instance id — a host no rule matches is
denied, so Dwara would silently stop working after a routine AWS operation. Give
them role-shaped names (`app-a`, `app-b`) and update `HostName` when ids change.
`ssmSshConfig` in `@dwara/cli` generates this block correctly.

`dwara doctor` detects an SSM host from its `ProxyCommand` and preflights the AWS
side *before* connecting, because every SSM misconfiguration otherwise arrives as
the same unhelpful SSH timeout.

## Step 4: on each server

The entire server-side footprint.

**An account and the key:**

```
# in that account's ~/.ssh/authorized_keys
restrict,pty ssh-ed25519 AAAA... dwara
```

`restrict` disables port forwarding, agent forwarding and X11. `pty` is added back
because some of what Dwara runs wants a terminal.

**A sudoers allow-list.** Dwara only ever runs `sudo -n`, so an unlisted command
fails immediately rather than hanging on a prompt. Grant specific commands, never
`ALL`:

```
# /etc/sudoers.d/dwara   (chmod 440, validate with visudo -c)
Cmnd_Alias DWARA_READ = /usr/bin/systemctl status *,    \
                        /usr/bin/systemctl show *,      \
                        /usr/bin/systemctl is-active *, \
                        /usr/bin/journalctl *,          \
                        /usr/bin/ss *,                  \
                        /usr/bin/du *,                  \
                        /usr/bin/df *
dwara ALL=(root) NOPASSWD: DWARA_READ
```

Paths differ by distro — `ss` is under `/usr/sbin` on Amazon Linux. **Do not guess:**
`dwara doctor` prints the exact line for every command it could not run, so run it
and paste what it asks for.

**Start with no sudo at all.** Genuinely. You lose process names on ports, disk
usage under `/var/log`, and the journal — and you learn how much Dwara gives you for
zero server-side risk before you grant anything. Widen deliberately, once you know
what you are missing.

Read the allow-list **as a whole** before pasting. Two traps worth knowing: `tee`
into a directory of systemd units plus permission to start units is full root, and a
trailing wildcard on a `find` rule permits arbitrary execution.

## Step 5: a policy

Nothing works without one — a host no rule matches is denied, which fails closed.

```yaml
# .dwara/policy.yaml
version: 1

defaults:
  allow: [read]
  deny: [reversible, config, destructive]

hosts:
  - match: 'my-vps'
    allow: [read]
    deny: [reversible, config, destructive]
```

**For a first host, make it read-only with `deny`, not `require_approval`.** An
approval prompt is a thing a tired person clicks at the end of a long session; a
`deny` is not. Widen it later, deliberately, when you know what you want.

`dwara init` writes a reasonable starting policy from your SSH config and registers
the MCP server with your client.

## Step 6: verify, including the part nobody checks

```bash
dwara doctor --ssh-config ~/.dwara/ssh_config --policy .dwara/policy.yaml
```

`doctor` reports reachability, which commands `sudo -n` will actually run, and
whether the policy covers the hosts it found. Expect to iterate here.

Then the test people skip. It is not "can Dwara connect" — it is **"can a plain
shell connect"**:

```bash
ssh -F ~/.dwara/ssh_config my-vps true   # must succeed
ssh my-vps true                          # must FAIL
```

If the second succeeds, your everyday credentials still reach the host, every guard
in Dwara is one Bash call away from being bypassed, and the hook is all that stands
there. Either remove your ordinary key from that host, or write down that you chose
not to.

## Summary of the footprint

| Where | What gets installed |
|---|---|
| Your machine | the `dwara` package, a key, a policy, an MCP server registration |
| Each server | one `authorized_keys` line, one `sudoers.d` file |
| Anywhere else | nothing |
