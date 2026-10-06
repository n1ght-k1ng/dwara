#!/usr/bin/env bash
# Known-good fix for redis-maxmemory: restore a workable cap and an eviction
# policy, then restart Redis.
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"
CONF=/etc/redis/redis.conf.d-dwara.conf
lab_root lab-cache bash -c "sed -i \
  -e 's/^maxmemory .*/maxmemory 64mb/' \
  -e 's/^maxmemory-policy .*/maxmemory-policy allkeys-lru/' $CONF"
lab_root lab-cache systemctl restart redis-server.service
lab_root lab-cache bash -c 'for _ in $(seq 1 15); do redis-cli ping >/dev/null 2>&1 && exit 0; sleep 1; done; exit 1'
