#!/usr/bin/env bash
# Bring the Dwara testbed up and wait until every host is healthy.
#
# Base images are built explicitly and in order, because the per-host images
# derive from them and compose does not order builds by FROM.

source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

require_docker
"$TESTBED_DIR/scripts/gen-keys.sh"
export_pubkey

log "building lab base images"
docker build -q -t dwara-lab-base:dev \
  -f "$TESTBED_DIR/images/base/Dockerfile" \
  --build-arg AUTHORIZED_KEY="$DWARA_LAB_PUBKEY" \
  --build-arg BASELINE_AUTHORIZED_KEY="$BASELINE_LAB_PUBKEY" "$TESTBED_DIR" >/dev/null
docker build -q -t dwara-lab-docker:dev \
  -f "$TESTBED_DIR/images/docker/Dockerfile" "$TESTBED_DIR" >/dev/null
ok "base images ready"

log "building lab host images"
compose build --quiet
ok "host images ready"

log "building the lab app image"
docker build -q -t dwara-lab-app:dev "$TESTBED_DIR/app" >/dev/null
ok "dwara-lab-app:dev ready"

log "starting lab hosts"
compose up -d
forget_host_keys

log "waiting for sshd on every host"
for host in "${LAB_HOSTS[@]}"; do
  wait_for "$host reachable over ssh" 120 lab_ssh "$host" true \
    || die "$host never accepted SSH; try: docker logs $host"
done

# The lab app and Kafka run as containers on their host's own Docker engine, so
# their images are shipped in over the socket rather than pulled from a registry.
log "seeding container images into the lab hosts"
for host in lab-api lab-staging; do
  wait_for "$host docker engine up" 120 docker exec "$host" docker info \
    || die "$host: docker engine never started"
  docker save dwara-lab-app:dev | docker exec -i "$host" docker load >/dev/null
  lab_ssh "$host" 'sudo -n systemctl restart dwara-app.service'
  ok "$host: lab app image loaded"
done

wait_for "lab-queue docker engine up" 120 docker exec lab-queue docker info \
  || die "lab-queue: docker engine never started"
if ! docker image inspect apache/kafka:3.9.0 >/dev/null 2>&1; then
  log "pulling apache/kafka:3.9.0 (once, on the developer machine)"
  docker pull -q apache/kafka:3.9.0 >/dev/null
fi
docker save apache/kafka:3.9.0 | docker exec -i lab-queue docker load >/dev/null
lab_ssh lab-queue 'sudo -n systemctl restart lab-kafka.service'
ok "lab-queue: kafka image loaded"

log "waiting for the stack to converge"
wait_for "postgres accepting connections" 120 \
  lab_ssh lab-db 'sudo -n pg_isready -q' || die "lab-db: postgres never became ready"
wait_for "redis responding" 60 \
  lab_ssh lab-cache 'redis-cli ping' || die "lab-cache: redis never responded"
wait_for "kafka broker up" 180 \
  lab_ssh lab-queue 'docker exec lab-kafka /opt/kafka/bin/kafka-broker-api-versions.sh --bootstrap-server lab-queue:9092' \
  || warn "lab-queue: kafka did not report ready in time"
wait_for "lab-api serving /health" 180 \
  curl -fsk --max-time 5 https://127.0.0.1:8443/health || die "lab-api: /health never returned 200"
wait_for "lab-staging serving /health" 180 \
  curl -fsk --max-time 5 https://127.0.0.1:8444/health || warn "lab-staging: /health not ready"

echo
ok "testbed is up"
printf '   %s\n' \
  "ssh:    ssh -F testbed/ssh_config lab-api" \
  "health: curl -k https://127.0.0.1:8443/health" \
  "status: pnpm testbed:status"
