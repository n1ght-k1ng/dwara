#!/usr/bin/env bash
# lab-queue: the Kafka broker is stopped, so the API's third dependency fails.
#
# The interesting part is where the symptom appears. Nothing on lab-api or
# lab-queue is obviously wrong -- lab-api serves, lab-queue is up and answers
# SSH -- and the only sign is one failing check inside /health on a third host.
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

log "breaking lab-queue: stopping the Kafka broker"
lab_root lab-queue systemctl stop lab-kafka.service
ok "lab-queue: lab-kafka is stopped"
