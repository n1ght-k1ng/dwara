#!/usr/bin/env bash
# Apply a failure scenario to the running testbed.
#
#   pnpm testbed:break <name>            apply the scenario
#   pnpm testbed:break <name> --check    assert the failure is live
#   pnpm testbed:break --list            list the scenarios
#
# Recover with `pnpm testbed:reset`.
#
# The scenarios live in `evals/scenarios/`, not here. They used to exist twice --
# once for the lab and once for the benchmark -- and two copies of a break that
# must stay identical is the kind of duplication that drifts silently and then
# makes a benchmark result wrong in a way nobody notices. One definition, two
# callers.

source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

SCENARIO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../evals/scenarios" && pwd)"

list_scenarios() {
  for dir in "$SCENARIO_DIR"/*/; do
    [ -f "$dir/break.sh" ] || continue
    name="$(basename "$dir")"
    desc="$(sed -n '2s/^# //p' "$dir/break.sh")"
    printf '  %-26s %s\n' "$name" "$desc"
  done
}

case "${1:-}" in
  ''|--list|-l)
    echo "Scenarios:"
    list_scenarios
    echo
    echo "Recover with: pnpm testbed:reset"
    exit 0
    ;;
esac

name="$1"
shift
dir="$SCENARIO_DIR/$name"

if [ ! -x "$dir/break.sh" ]; then
  echo "unknown scenario: $name" >&2
  echo "Scenarios:" >&2
  list_scenarios >&2
  exit 1
fi

require_docker

# `--check` here means what it always meant: assert the failure is live. In the
# scenario format that is `check.sh --broken`, because a bare `check.sh` asks
# the opposite question -- whether the scenario has been resolved.
if [ "${1:-}" = "--check" ]; then
  exec "$dir/check.sh" --broken
fi

exec "$dir/break.sh" "$@"
