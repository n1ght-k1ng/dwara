# lab-cache: Redis 7 as a systemd service.
FROM dwara-lab-base:dev

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
 && apt-get install -y --no-install-recommends redis-server redis-tools \
 && rm -rf /var/lib/apt/lists/*

# Reachable on the lab network with a small maxmemory, so the eviction and
# memory-pressure scenarios are reachable without a huge dataset.
RUN printf '%s\n' \
      "bind 0.0.0.0" \
      "protected-mode no" \
      "maxmemory 64mb" \
      "maxmemory-policy allkeys-lru" \
      "appendonly no" \
      "save 900 1" \
      > /etc/redis/redis.conf.d-dwara.conf \
 && printf '\ninclude /etc/redis/redis.conf.d-dwara.conf\n' >> /etc/redis/redis.conf \
 && systemctl enable redis-server.service

COPY sudoers/dwara-lab-cache /etc/sudoers.d/dwara-lab-cache
RUN chmod 440 /etc/sudoers.d/dwara-lab-cache && visudo -c -q
