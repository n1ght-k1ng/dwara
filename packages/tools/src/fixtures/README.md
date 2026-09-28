# Parser fixtures

Real command output, captured from the testbed with
`ssh -F testbed/ssh_config <host> '<command>'`. Parsers are tested against these
rather than against output written to match the parser — which is the failure
mode that makes a parser pass its tests and break on the first real host.

`healthy/` is the lab at baseline. `broken/` is the lab under the break
scenarios in `testbed/breaks/`, because a parser that only handles the healthy
shape is useless exactly when it is needed:

| Prefix | Scenario | What the parser has to cope with |
|---|---|---|
| `crashloop.*` | `api-crash-loop` | `NRestarts=4`, and `docker ps` returning **nothing** because the container is between restarts |
| `redisdown.*` | `redis-down` | `LoadState=masked`, `MainPID=0`, `SubState=dead` |
| `diskfull.*` | `disk-full-logs` | a filesystem at `100%` with `0` available |
| `nginxbad.*` | `nginx-bad-config` | nginx `active (running)` while every request 502s; the wrong port appears only in the error log |

Some fixtures are deliberately empty (`host_overview.failed-units`,
`security_audit.world-writable`, `crashloop.docker_ps`). Empty output is a real
answer from a real host and a parser must not treat it as a failure.

## Re-capturing

The commands are listed in the git history of this directory. Any capture needs
the lab at a known state — `pnpm testbed:reset` first, then the relevant
`pnpm testbed:break <name>`.

The only credential in here is `labpass`, the documented testbed dummy. Nothing
captured from a real machine belongs in this directory.
