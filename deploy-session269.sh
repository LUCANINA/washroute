#!/usr/bin/env bash
# Deploy the five edge functions affected by commits a69730b and d1d5205.
#
# WHY FIVE. d1d5205 changed supabase/functions/_shared/derive-schedule.ts, which is
# COMPILED INTO every function that imports it — a shared file has no deploy of its
# own. a69730b changed loan-ingest-statement directly. loan-ingest-statement was
# deployed at 14:54 UTC and d1d5205 was committed at 15:29, so it predates the shared
# change too and is on this list like the rest.
#
# WHY THE FLAG DIFFERS PER FUNCTION, and it is not cosmetic. Omitting --no-verify-jwt
# on a function that is currently verify_jwt:false FLIPS it to requiring a JWT and
# breaks every caller (session 260 nearly killed the Stripe payout webhook this way).
# Adding it where it does not belong weakens auth. Each flag below was read from the
# live project today, not assumed:
#
#   verify_jwt=true  -> no flag   : loan-ingest-statement, loan-derive-schedule,
#                                   loan-record-principal-payment
#   verify_jwt=false -> --no-verify-jwt : loan-xero-post, loan-bundle
#
# loan-bundle is ~404KB and can only go through this CLI, never the MCP tool.

set -uo pipefail
REF=umjpbuxrdydwejqtensq
cd "$(dirname "$0")" || exit 1

echo "Deploying 5 edge functions to $REF"
echo "Repo: $(pwd)"
echo "HEAD: $(git rev-parse --short HEAD 2>/dev/null)"
echo
read -r -p "Press Enter to start, or Ctrl-C to stop. " _

fail=0
deploy () {   # $1 = function name, $2 = extra flags (may be empty)
  echo
  echo "──────────────────────────────────────────────"
  echo "▶ $1 ${2:-（no extra flags）}"
  if npx -y supabase@latest functions deploy "$1" --project-ref "$REF" ${2:-}; then
    echo "✔ $1 accepted"
  else
    echo "✘ $1 FAILED — stopping so you can look at it"
    fail=1
  fi
}

deploy loan-ingest-statement          ""
[ $fail -eq 0 ] && deploy loan-derive-schedule          ""
[ $fail -eq 0 ] && deploy loan-record-principal-payment ""
[ $fail -eq 0 ] && deploy loan-xero-post                "--no-verify-jwt"
[ $fail -eq 0 ] && deploy loan-bundle                   "--no-verify-jwt"

echo
if [ $fail -eq 0 ]; then
  echo "All five accepted."
else
  echo "One or more FAILED — see above. Nothing after the failure was attempted."
fi
echo
echo "ACCEPTED IS NOT RUNNING. Tell Claude when this finishes and it will check each"
echo "function actually boots and carries the new code — a version number can coincide,"
echo "and in session 264 a function reported deployed had never booted at all."
exit $fail
