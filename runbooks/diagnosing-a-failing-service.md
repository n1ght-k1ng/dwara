# Diagnosing a failing service

Evidence before conclusions. Every claim should name the tool output it came from.

## Order of work

1. `read_host_overview` — is the host itself healthy? `systemd.failedUnits` names
   the units to look at next. A full disk or exhausted memory here explains
   failures that otherwise look unrelated.
2. `read_service_status` on the named unit. **Check `restarts`.** A unit in a
   crash loop reports `active` at the instant you ask, because systemd has just
   restarted it. Call twice, a few seconds apart, and watch the count move.
3. `read_tail_logs` with that unit. The first occurrence of a repeating error is
   the one that names the cause; later ones are consequences.
4. If the workload is a container, `read_docker_ps` then `read_container_logs`
   and `read_container_inspect`. An empty container list is a finding, not a
   failure — a crash-looping container is absent between attempts.

## Things that mislead

- **A healthy service with failing clients.** nginx `active`, its port
  listening, and every request still failing. Compare the upstream in
  `read_read_config` against what `read_open_ports` says is actually listening.
  A wrong port is invisible from the service's own status.
- **An expired certificate.** Nothing in service status or ports shows it. Only
  `read_cert_expiry` will.
- **A container killed by the kernel.** `read_container_inspect` reports
  `state.oomKilled`; the application's own logs never mention it, because it was
  not given the chance to say anything.
- **Postgres refusing connections while `active`.** Connection slots can be
  exhausted. The client-side error names it; the server looks fine.
- **A full bounded mount.** `/var/log` can be at 100% while `/` has plenty free.
  Check the path the failing service actually writes to.

## Reporting

State the root cause, the evidence for it, and the smallest change that would
fix it. Say plainly when the evidence does not support a conclusion.
