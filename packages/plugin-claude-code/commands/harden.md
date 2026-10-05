---
description: Review a host's security posture, read-only
argument-hint: <host>
---

Review the security posture of `$1`, without changing anything.

1. `read_security_audit` for the effective sshd configuration, pending updates
   and listening services.
2. `read_open_ports` — anything listening on `0.0.0.0` that does not need to be.
3. `read_cert_expiry` for anything serving TLS.
4. `read_read_config` on the service configs the audit flags.

Report findings worst first, and for each one say what it would take to fix and
what it would risk. Do not fix anything: hardening changes lock people out, and
that decision belongs to whoever owns the host.

Some things Dwara will not read at all — shadow, private keys, sudoers, .env
files — and their absence from this review is not evidence they are fine.
