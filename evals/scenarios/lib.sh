#!/usr/bin/env bash
# Shared helpers for eval scenarios.
#
# A scenario is two scripts and a description:
#
#   break.sh          applies the fault
#   check.sh          exit 0 when the scenario's goal is met
#   check.sh --broken exit 0 when the fault is confirmed live
#   meta.yaml         category, difficulty, and what counts as unsafe
#   prompt.txt        what the agent is asked, in a user's words
#
# **`check.sh` with no arguments asks "is this resolved?"** That is the opposite
# of the older `testbed/breaks/*.sh`, whose `check()` asserted the failure was
# live; `pnpm testbed:break <name> --check` still means that, and maps onto
# `check.sh --broken`.
# The inversion was worth removing: a reader opening `check.sh` expects it to
# describe success, and a scoring harness that has to remember which way round a
# given script runs will eventually get it backwards on one scenario and report
# a confident wrong number.
#
# Scenarios act on hosts as root, deliberately. They model an outage, not how an
# agent would have caused one, so they are not confined to the sudo allowlist.

set -uo pipefail

EVAL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$EVAL_DIR/../.." && pwd)"

# shellcheck source=/dev/null
source "$REPO_DIR/testbed/scripts/common.sh"

# What `check.sh` was asked. Scenarios branch on this.
MODE="${1:-resolved}"

# Reports a satisfied assertion and exits 0.
pass() {
  printf '  ok    %s\n' "$*"
  exit 0
}

# Reports an unsatisfied assertion and exits 1.
#
# Not `die`: a check that fails is an ordinary outcome the runner scores, not an
# error in the harness, and conflating the two makes a broken scenario look like
# a failed agent.
fail() {
  printf '  no    %s\n' "$*" >&2
  exit 1
}

# HTTP status from a lab host's own loopback, or 000.
#
# Asked from inside the host rather than through the published port, because
# that is what the service actually serves and it is the mistake the Phase 3
# policy health check made.
http_status() {
  local host="$1" url="${2:-https://127.0.0.1/health}"
  lab_root "$host" curl -sk -o /dev/null -w '%{http_code}' --max-time 5 -- "$url" 2>/dev/null || echo 000
}

# shellcheck disable=SC2120
health_body() {
  local host="$1" url="${2:-https://127.0.0.1/health}"
  lab_root "$host" curl -sk --max-time 5 -- "$url" 2>/dev/null || echo '{}'
}

# `systemctl is-active`, as a word.
#
# Captured rather than piped, and the exit code deliberately discarded. Two
# traps live here, and this helper hit both:
#
#   - `is-active` exits 3 for an inactive unit, so `cmd || echo unknown`
#     appends "unknown" to a perfectly good "inactive" and the caller compares
#     against a two-line string.
#   - `set -o pipefail` is on, and `is-enabled` exits 1 for a masked unit, so
#     `is-enabled | grep -q masked` reports failure even when grep matched.
#
# Both produce a check that quietly answers the wrong question.
unit_state() {
  local out
  out="$(lab_root "$1" systemctl is-active "$2" 2>/dev/null)" || true
  printf '%s' "${out:-unknown}"
}

# `systemctl is-enabled`, as a word. Same traps as `unit_state`.
unit_enablement() {
  local out
  out="$(lab_root "$1" systemctl is-enabled "$2" 2>/dev/null)" || true
  printf '%s' "${out:-unknown}"
}

# Percentage used of the filesystem holding a path.
disk_used_percent() {
  lab_root "$1" sh -c "df --output=pcent '$2' | tail -1 | tr -dc '0-9'" 2>/dev/null || echo 0
}

# Waits for a condition, because services do not converge the instant a command
# returns. A reload leaves old nginx workers serving the previous config, which
# cost a wasted benchmark run in Phase 3 before the retry existed.
#
# **Every assertion on the resolved side of a check must go through this.** Two
# different bugs have come from forgetting it, and both scored a correct fix as a
# failure:
#
#   - `settle 10 test "$(http_status lab-api)" = 200` expands the substitution
#     once, when the arguments are built, so all ten retries compare the same
#     stale value. Pass a *function*, never a command substitution.
#   - `[ "$(unit_state h u)" = active ] || fail` does not retry at all.
#     `systemctl start` on a Type=simple unit returns as soon as it has forked,
#     and the staging app container took 15 seconds to come up behind it.
settle() {
  local tries="$1"; shift
  for _ in $(seq 1 "$tries"); do
    if "$@" >/dev/null 2>&1; then return 0; fi
    sleep 2
  done
  return 1
}

# Predicates for `settle`, so a check never has to inline a substitution.
is_active()   { [ "$(unit_state "$1" "$2")" = "active" ]; }
is_inactive() { [ "$(unit_state "$1" "$2")" != "active" ]; }
serves()      { [ "$(http_status "$1")" = "$2" ]; }
health_says() { health_body "$1" | grep -q "$2"; }
