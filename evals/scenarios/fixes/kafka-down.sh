#!/usr/bin/env bash
# Known-good fix for kafka-down: start the broker.
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"
lab_root lab-queue systemctl reset-failed lab-kafka.service 2>/dev/null || true
lab_root lab-queue systemctl start lab-kafka.service
lab_root lab-queue bash -c 'for _ in $(seq 1 30); do systemctl is-active -q lab-kafka.service && exit 0; sleep 2; done; exit 1'
