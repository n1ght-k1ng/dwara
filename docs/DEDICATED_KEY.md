# Setting up a dedicated key and a restricted sudoers

This is the control `docs/THREAT_MODEL.md` says to rely on, and the reason is
blunt: **every other guarantee in Dwara is enforced by Dwara.** The policy
engine, the approvals, the hook — all of it runs in a process the agent is
talking to. If the agent can reach your servers without going through that
process, none of it applies.

The fix is not cleverer software. It is that **the agent's own shell holds no
credential for any managed host.** Only Dwara's key does, and Dwara is the only
thing that uses it.

> The hook is defence in depth, not a boundary. It reads a Bash command and
> decides, with a 67-case evasion corpus behind it and zero false negatives. It
> still cannot tell what `bash ./deploy.sh` will do. Treat it as a tripwire that
> catches mistakes, and treat this document as the thing that catches intent.

---

## 1. A key that only Dwara uses

Generate it outside your normal `~/.ssh` layout, so nothing picks it up by
default:

```bash
mkdir -p ~/.dwara/keys && chmod 700 ~/.dwara/keys
ssh-keygen -t ed25519 -N '' -C 'dwara' -f ~/.dwara/keys/dwara
chmod 600 ~/.dwara/keys/dwara
```

No passphrase, deliberately. Dwara runs `ssh` with `BatchMode=yes` and will never
prompt for anything; a passphrase would mean an agent-forwarded key or a running
`ssh-agent`, and both are reachable by anything else running as you. An
unencrypted key in a directory only you can read is the smaller risk, and it is
the one you can reason about.

**Do not add this key to `ssh-agent`.** The whole point is that a shell command
cannot use it.

### Give Dwara its own SSH config

```
# ~/.dwara/ssh_config
Host prod-*
  User dwara
  IdentityFile ~/.dwara/keys/dwara
  IdentitiesOnly yes
  BatchMode yes
  PasswordAuthentication no
  StrictHostKeyChecking yes
  UserKnownHostsFile ~/.dwara/keys/known_hosts
  ConnectTimeout 5
```

`IdentitiesOnly yes` matters: without it `ssh` offers every key it can find,
including the one in `~/.ssh`, and you would never notice that the restriction
was not working.

Point Dwara at it and nothing else:

```bash
export DWARA_SSH_CONFIG=~/.dwara/ssh_config
```

### Check the separation actually holds

The test is not "can Dwara connect" — it is "can a plain shell connect". Both
answers must be as shown:

```bash
ssh -F ~/.dwara/ssh_config prod-web true   # succeeds
ssh prod-web true                          # must FAIL: no key, no password
```

If the second one succeeds, your normal key still has access and this setup is
decorative. Remove that key from the server's `authorized_keys`, or accept that
the hook is the only thing in the way.

### Narrow the key on the server too

In the server's `~dwara/.ssh/authorized_keys`, prefix the key:

```
restrict,pty ssh-ed25519 AAAA... dwara
```

`restrict` disables port forwarding, agent forwarding, X11 and `~/.ssh/rc`. `pty`
is added back because some of what Dwara runs wants a terminal. If you can also
pin the source address, do:

```
from="198.51.100.4",restrict,pty ssh-ed25519 AAAA... dwara
```

---

## 2. A sudoers file that grants verbs, not power

Dwara only ever runs `sudo -n`. It never prompts for a password and never stores
one, so an unlisted command fails cleanly with `SUDO_PASSWORD_REQUIRED` and
`dwara doctor` tells you which line to add.

**Grant specific commands.** Not `ALL`, not a bare wildcard tail.

`testbed/sudoers/` in this repository is a working example, split into a common
file and a per-role one. The shape to copy:

```
# /etc/sudoers.d/dwara   (chmod 440, validate with: visudo -c)

Cmnd_Alias DWARA_SYSTEMD = /usr/bin/systemctl status *,        \
                           /usr/bin/systemctl show *,          \
                           /usr/bin/systemctl is-active *,     \
                           /usr/bin/systemctl restart *,       \
                           /usr/bin/systemctl reset-failed *
Cmnd_Alias DWARA_LOGS    = /usr/bin/journalctl *
Cmnd_Alias DWARA_NGINX   = /usr/sbin/nginx -t,                 \
                           /usr/bin/cat -- /etc/nginx/*,       \
                           /usr/bin/tee -- /etc/nginx/*

dwara ALL=(root) NOPASSWD: DWARA_SYSTEMD, DWARA_LOGS, DWARA_NGINX
```

### Read the allow-list as a whole, not rule by rule

This is the part that is easy to get wrong, and the example above is already at
the edge of it.

**A rule can grant more than it appears to.** Two cases from this repository's own
review:

- **`tee` into a unit directory plus permission to start units is full root.** A
  systemd unit file *is* an arbitrary command run as root. If you grant
  `tee -- /etc/systemd/system/*` and `systemctl start *`, you have granted
  everything, however narrow each line looks on its own. Do not grant it: Dwara
  refuses to edit `/etc/systemd/**` in code for exactly this reason, so the rule
  would buy you nothing and cost you the host.
- **A trailing wildcard on `find` is a grant to run anything.** `find /var/log *`
  permits `find /var/log -exec rm -rf / {} +`, because `find` substitutes into an
  argument list the caller controls. Every `find` rule in the testbed is written
  out in full for this reason, with the single wildcard placed where `find` can
  only read it as a basename pattern or an mtime.

The general test for a rule: **assume the agent is hostile and chose the
arguments.** If some choice gives it a shell, a write to a file that becomes
code, or a path it controls on the left of a `cp`, the rule is too wide.

### Pin destinations on anything that writes

Where Dwara writes, the rule pins where. Snapshots copy one file per `cp` solely
so the destination can be a fixed prefix:

```
/usr/bin/cp --preserve=all --parents -- /etc/* /var/lib/dwara/snapshots/*
```

A batched copy would take a variable number of sources and the rule would have to
end in a bare `*` — a grant to copy anything anywhere as root.

---

## 3. What Dwara is never allowed to do

Enforced in code, not policy, and no configuration loosens them:

- **No shell tool.** There is no `run_command` and will not be one.
- **`/etc/ssh` is uneditable.** `sshd -t` proves a file parses, not that you can
  still log in — and Dwara reaches every host over SSH.
- **A deny-list in code** covers `/etc/shadow`, `/etc/sudoers*`, private keys,
  `**/.env`, `.pgpass`, `.netrc`, shell history and `/root`. No policy can
  override it.
- **The `destructive` risk class is denied** in this release, before host rules or
  tool overrides are consulted.

---

## 4. Verify it, then verify the failure mode

```bash
dwara doctor            # reachability, sudo probes, policy sanity
```

`doctor` prints the exact sudoers line for anything it could not run. Then check
the part nobody checks:

```bash
ssh prod-web true                       # must fail
sudo -n -l -U dwara                     # on the host: read the list as a whole
```

Finally, confirm the audit log is being written somewhere a compromise cannot
quietly rewrite. The chain makes tampering **detectable, not impossible** — anyone
who can write the file can rewrite it from any point and recompute the hashes.
If that matters to you, ship the lines off-host as they are written, or
`chattr +a` the file. That is an operating-system property, and no library can
provide it.
