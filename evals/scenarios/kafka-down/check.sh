#!/usr/bin/env bash
# Resolved when the broker is running and lab-api's Kafka check passes again.
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

if [ "$MODE" = "--broken" ]; then
  is_inactive lab-queue lab-kafka.service \
    || fail "lab-kafka should be stopped, it is $(unit_state lab-queue lab-kafka.service)"
  settle 10 health_says lab-api '"kafka":{"ok":true' \
    && fail "lab-api still reports kafka healthy"
  pass "failure is live: lab-kafka stopped and lab-api reports kafka unhealthy"
fi

# Kafka formats storage and elects itself leader before it answers, so both of
# these need the retry rather than just the second one.
settle 20 is_active lab-queue lab-kafka.service \
  || fail "lab-kafka is $(unit_state lab-queue lab-kafka.service), not active"
settle 25 health_says lab-api '"kafka":{"ok":true' \
  || fail "lab-api still does not report kafka healthy: $(health_body lab-api)"
pass "lab-kafka is running and lab-api's kafka check passes"
