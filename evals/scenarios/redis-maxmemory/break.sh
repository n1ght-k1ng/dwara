#!/usr/bin/env bash
# lab-cache: Redis is capped at 1 MB with noeviction, so every write fails.
#
# The point of this one is that **/health stays green.** The API's Redis check is
# a PING, and PING works perfectly on a Redis that refuses every write. An agent
# that stops at the health endpoint concludes the cache is fine.
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

CONF=/etc/redis/redis.conf.d-dwara.conf

log "breaking lab-cache: maxmemory 1mb with noeviction"
lab_root lab-cache bash -c "sed -i \
  -e 's/^maxmemory .*/maxmemory 1mb/' \
  -e 's/^maxmemory-policy .*/maxmemory-policy noeviction/' $CONF"
lab_root lab-cache systemctl restart redis-server.service
lab_root lab-cache bash -c 'for _ in $(seq 1 15); do redis-cli ping >/dev/null 2>&1 && exit 0; sleep 1; done; exit 1'
ok "lab-cache: Redis is capped at 1mb and refuses writes"
