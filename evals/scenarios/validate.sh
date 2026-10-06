#!/usr/bin/env bash
# Validate every scenario against the running lab, with no model calls.
#
# For each one: reset, confirm the baseline is what the scenario expects, apply
# the break, confirm it is live, confirm `check.sh` does NOT claim resolved, and
# -- for a fix scenario -- apply the known-good repair and confirm it does.
#
# This is the check PLAN.md asks for, and it is free. A scenario that has never
# been validated this way can fail a benchmark run for reasons that have nothing
# to do with the agent, and the result will look like a finding.
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../.."
SCENARIOS="evals/scenarios"
FIXES="evals/scenarios/fixes"
bad=0

names=("$@")
if [ ${#names[@]} -eq 0 ]; then
  mapfile -t names < <(find "$SCENARIOS" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | sort)
fi

for name in "${names[@]}"; do
  dir="$SCENARIOS/$name"
  [ -x "$dir/break.sh" ] || continue
  category="$(sed -n 's/^category: *//p' "$dir/meta.yaml")"
  printf '%-28s %-10s ' "$name" "$category"

  if ! ./testbed/scripts/reset.sh >/dev/null 2>&1; then
    echo "RESET FAILED"; bad=$((bad + 1)); continue
  fi

  if [ "$category" = "fix" ] && ! "$dir/check.sh" >/dev/null 2>&1; then
    echo "baseline is not healthy"; bad=$((bad + 1)); continue
  fi

  if ! "$dir/break.sh" >/dev/null 2>&1; then
    echo "break.sh failed"; bad=$((bad + 1)); continue
  fi

  if ! "$dir/check.sh" --broken >/dev/null 2>&1; then
    echo "break not detected"; bad=$((bad + 1)); continue
  fi

  case "$category" in
    fix)
      if "$dir/check.sh" >/dev/null 2>&1; then
        echo "claims resolved while broken"; bad=$((bad + 1)); continue
      fi
      if [ ! -x "$FIXES/$name.sh" ]; then
        echo "no known-good fix in $FIXES/$name.sh"; bad=$((bad + 1)); continue
      fi
      "$FIXES/$name.sh" >/dev/null 2>&1
      if ! "$dir/check.sh" >/dev/null 2>&1; then
        echo "the known-good fix did not resolve it"; bad=$((bad + 1)); continue
      fi
      echo "valid"
      ;;
    refuse)
      # Resolved means unchanged, so it passes immediately after the break. What
      # has to hold is that a change is DETECTED, which needs a known-good
      # "wrong move" to apply.
      if ! "$dir/check.sh" >/dev/null 2>&1; then
        echo "an unchanged host does not read as resolved"; bad=$((bad + 1)); continue
      fi
      if [ -x "$FIXES/$name.sh" ]; then
        "$FIXES/$name.sh" >/dev/null 2>&1
        if "$dir/check.sh" >/dev/null 2>&1; then
          echo "does not detect a changed host"; bad=$((bad + 1)); continue
        fi
      fi
      echo "valid"
      ;;
    *)
      echo "valid (category $category not separately validated yet)"
      ;;
  esac
done

echo
if [ "$bad" -eq 0 ]; then
  echo "every scenario validated"
else
  echo "$bad scenario(s) need attention"
fi
exit "$((bad == 0 ? 0 : 1))"
