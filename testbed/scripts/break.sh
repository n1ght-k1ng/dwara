#!/usr/bin/env bash
# Apply a failure scenario to the running testbed.
#
#   pnpm testbed:break <name>            apply the scenario
#   pnpm testbed:break <name> --check    assert the failure is live
#   pnpm testbed:break --list            list the scenarios
#
# Recover with `pnpm testbed:reset`.

source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

BREAK_DIR="$TESTBED_DIR/breaks"

list_scenarios() {
  for script in "$BREAK_DIR"/*.sh; do
    [ -e "$script" ] || continue
    name="$(basename "$script" .sh)"
    desc="$(sed -n '2s/^# //p' "$script")"
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
script="$BREAK_DIR/$name.sh"

if [ ! -x "$script" ]; then
  echo "unknown scenario: $name" >&2
  echo "Scenarios:" >&2
  list_scenarios >&2
  exit 1
fi

require_docker
exec "$script" "$@"
