# Dwara testbed

Five SSH-reachable "hosts" that mimic the *shape* of a backend production stack,
so Dwara's tools, policy and benchmark have somewhere realistic to run.

Each host is an Ubuntu 24.04 container running systemd as PID 1 with sshd, a
`dwara` user, and passwordless sudo for an allowlist of commands.

> **The lab contains no real company code, configuration, data, hostnames or
> credentials.** Every name here is `lab-*`, the application is a dummy service
> written for this repository, and every credential is a throwaway lab value.
> Nothing in this directory may be pointed at a real machine.

## Prerequisites

- Docker with Compose v2, and a running daemon (Docker Desktop counts)
- Node 20+ (`nvm use` picks it up from `.nvmrc`) and pnpm
- Roughly 6 GB of free disk for images and 4 GB of RAM for the five hosts

## Hosts

| Host | SSH | Also exposed | Runs |
|---|---|---|---|
| `lab-api` | 2201 | 8443 → 443 | nginx (self-signed TLS) + Docker running the lab app |
| `lab-db` | 2202 | — | PostgreSQL 16 (systemd), seeded `labdb` |
| `lab-cache` | 2203 | — | Redis 7 (systemd), 64 MB maxmemory |
| `lab-queue` | 2204 | — | Docker running single-node Kafka (KRaft) |
| `lab-staging` | 2205 | 8444 → 443 | same image as `lab-api`, tagged staging |

All ports bind to `127.0.0.1` only.

## Usage

Run everything from the repo root — `testbed/ssh_config` refers to the lab key by
a repo-relative path.

```bash
pnpm testbed:up        # build images, start hosts, wait for the stack to be healthy
pnpm testbed:status    # one line per host: container, systemd, key services, /health
pnpm testbed:break     # list failure scenarios
pnpm testbed:reset     # back to a known-good baseline
pnpm testbed:down      # stop (add --volumes to discard lab state)

ssh -F testbed/ssh_config lab-api
curl -k https://127.0.0.1:8443/health
```

## Failure scenarios

`pnpm testbed:break <name>` applies one; `testbed/breaks/<name>.sh --check` asserts
the failure is actually live, which is what makes them usable as benchmark
fixtures. Recovery is always `pnpm testbed:reset`.

| Scenario | Host | Symptom |
|---|---|---|
| `api-crash-loop` | lab-api | app exits at boot on bad DB credentials; systemd restarts it forever; 502 |
| `disk-full-logs` | lab-api | `/var/log` fills; services can no longer write logs |
| `nginx-bad-config` | lab-api | upstream port is wrong; every request is a 502 while `nginx -t` still passes |
| `redis-down` | lab-cache | redis stopped and masked; `/health` degraded on the redis check only |
| `postgres-max-connections` | lab-db | `max_connections=5` with every slot held; postgres stays *active* but refuses connections |

## How it is put together

- **Images.** `images/base` is systemd + sshd + sudo. `images/docker` adds a Docker
  engine for hosts whose workloads are containers. The per-host images derive from
  those, so `up.sh` builds them explicitly — Compose does not order builds by `FROM`.
- **Docker-in-Docker.** Both `/var/lib/docker` and `/var/lib/containerd` are named
  volumes. Without that, overlay mounts inside a lab host fail with `EINVAL`.
- **No registry.** The app and Kafka images are shipped in with
  `docker save | docker exec -i <host> docker load`, so the lab works offline after
  the first pull.
- **Host keys.** Rebuilding an image gives a host a new SSH host key, so `up.sh`
  drops the stale entries from `testbed/.keys/known_hosts`. Host key checking stays
  on; it is not disabled for the lab.
- **`/var/log` on lab-api** is a 128 MB tmpfs, so the log-explosion scenario fills a
  real filesystem without eating the developer's disk. `tmpfiles.d` recreates the
  directories services expect there at boot.
- **Reset is a full recreate.** The Phase 5 benchmark needs every scenario to start
  from an identical state, and a break script may leave a host in any condition.

## sudo allowlist

`sudoers/dwara-common` plus a per-host file grant `NOPASSWD` for systemctl verbs,
journalctl, read-only inspection commands, and each host's own config reads. Anything
else is refused, which is what `dwara doctor` will check against in Phase 1. Dwara's
safety guarantees do not depend on this file — they live in policy and in code — but
a lab that handed the agent root would not tell us anything useful.
