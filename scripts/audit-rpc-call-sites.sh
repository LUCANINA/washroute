#!/usr/bin/env bash
# Check 24 — Critical Driver-App RPC Call Sites Present (P0)
#
# Filesystem check, not SQL. Guards the merge-regression class of bug: a conflict
# resolution silently reverting a customer-impacting fix that is already live.
#
# On 2026-05-27 two driver-app fixes shipped (ebeb31a route-cushion guard,
# 43666cd four stop-fetches rewired onto the SECURITY DEFINER RPCs). A later merge
# favoured the WIP side and dropped both. The RPCs were still in the database, the
# client had stopped calling them, and by the next morning the driver's route was
# blank again.
#
# The RPCs and the migration are the source of truth. If the client stops calling
# them the fix is gone, regardless of git history.
#
# Exit 0 = all call sites present. Exit 1 = at least one is missing (P0).
set -uo pipefail
cd "$(dirname "$0")/.." || exit 2

F=driver-app/index.html
[ -f "$F" ] || { echo "FAIL: $F not found"; exit 2; }

fail=0
for rpc in get_driver_route_stops get_driver_override_stops get_driver_stop_addresses; do
  n=$(grep -c "$rpc" "$F")
  if [ "$n" -eq 0 ]; then
    printf '🔴 %-28s 0 call sites — REGRESSION\n' "$rpc"; fail=1
  else
    printf '✅ %-28s %s call sites\n' "$rpc" "$n"
  fi
done

if [ "$fail" -eq 1 ]; then
  echo
  echo "A call site is missing. Recent commits that touched it:"
  git log --all --oneline -S "get_driver_route_stops" -- "$F" | head -5
  echo
  echo "Restore with: git checkout <commit> -- $F"
fi
exit $fail
