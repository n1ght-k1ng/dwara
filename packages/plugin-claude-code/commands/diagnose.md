---
description: Work out what is wrong with a host, using evidence rather than guesses
argument-hint: <host> [what you are seeing]
---

Diagnose `$1` with Dwara's read tools. $ARGUMENTS

Do not change anything. This command is for finding out what is true.

Work in this order, and stop as soon as the evidence points somewhere specific:

1. `read_host_overview` first. It reports failed units, memory and filesystem
   pressure, and it is the cheapest way to rule out whole categories.
2. Follow what it tells you. Failed unit → `read_service_status`, then
   `read_tail_logs` for that unit. Disk pressure → `read_disk_usage`. Nothing
   obvious → `read_open_ports` and `read_docker_ps`.
3. Read the configuration before concluding it is wrong. `read_read_config`
   shows what a service is actually set to do, which is often not what everyone
   assumes.

Check `restarts` before calling a service healthy. A unit in a crash loop
reports `active` at the moment you ask, because systemd has just started it
again.

Finish with: what is broken, the specific evidence for it, and what you would
change. Name the tool you would use to change it. Do not change it yet.
