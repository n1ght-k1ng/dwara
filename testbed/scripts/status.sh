#!/usr/bin/env bash
# Print one line per lab host: container state, systemd state, key services.

source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

require_docker

declare -A HOST_SERVICES=(
  [lab-api]="ssh nginx docker dwara-app"
  [lab-db]="ssh postgresql@16-main"
  [lab-cache]="ssh redis-server"
  [lab-queue]="ssh docker lab-kafka"
  [lab-staging]="ssh nginx docker dwara-app"
)

printf '%-12s %-10s %-12s %s\n' HOST CONTAINER SYSTEMD SERVICES
for host in "${LAB_HOSTS[@]}"; do
  container="$(docker inspect -f '{{.State.Status}}' "$host" 2>/dev/null || echo missing)"

  if [ "$container" != "running" ]; then
    printf '%-12s %-10s %-12s %s\n' "$host" "$container" "-" "-"
    continue
  fi

  systemd="$(lab_ssh "$host" 'systemctl is-system-running' 2>/dev/null || echo unreachable)"

  services=""
  for unit in ${HOST_SERVICES[$host]}; do
    state="$(lab_ssh "$host" "systemctl is-active ${unit}.service" 2>/dev/null || echo unknown)"
    if [ "$state" = "active" ]; then
      services+="${C_GREEN}${unit}${C_OFF} "
    else
      services+="${C_RED}${unit}:${state}${C_OFF} "
    fi
  done

  printf '%-12s %-10s %-12s %s\n' "$host" "$container" "$systemd" "$services"
done

echo
for entry in "lab-api https://127.0.0.1:8443/health" "lab-staging https://127.0.0.1:8444/health"; do
  set -- $entry
  code="$(curl -sk -o /dev/null -w '%{http_code}' --max-time 5 "$2" 2>/dev/null || echo 000)"
  if [ "$code" = "200" ]; then
    ok "$1 /health -> $code"
  else
    warn "$1 /health -> $code"
  fi
done
