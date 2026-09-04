#!/usr/bin/env bash
# Deploy the ONE edge function changed by the statement-date-basis fix.
#
# WHY ONE. The change is in supabase/functions/_shared/statement-period.ts (new)
# and loan-find-difference/index.ts. A shared file has no deploy of its own -- it
# is compiled into whatever imports it -- and statement-period.ts is imported by
# loan-find-difference and nothing else today. Verified before writing this:
#   grep -rl "statement-period" supabase/functions/
#
# THE FLAG IS NOT COSMETIC. loan-find-difference is currently verify_jwt=false
# (read from the live project 2026-09-04, not assumed) and does its own
# admin/manager/cpa role check inside. Omitting --no-verify-jwt would flip it to
# requiring a platform JWT and break every call from the dashboard -- the same
# way session 260 nearly killed the Stripe payout webhook.
#
#   verify_jwt=false -> --no-verify-jwt : loan-find-difference
#
# THE MIGRATION IS ALREADY APPLIED and the data API has been PROVEN to see the
# new column (loan_accounts.statement_date_basis): a REST select naming it
# returned 200 while a control column returned 42703. That ordering matters --
# session 176 deployed code against a column the schema cache had not picked up
# and took down all card charging for fifteen hours.
set -uo pipefail
REF=umjpbuxrdydwejqtensq
cd "$(dirname "$0")" || exit 1

echo "Deploying 1 edge function to $REF"
echo "HEAD: $(git rev-parse --short HEAD 2>/dev/null)"
echo
npx -y supabase@latest functions deploy loan-find-difference --project-ref "$REF" --no-verify-jwt
rc=$?
echo
if [ $rc -eq 0 ]; then
  echo "✔ accepted."
else
  echo "✘ FAILED — see above."
fi
echo
echo "ACCEPTED IS NOT RUNNING. Tell Claude when this finishes: it will read the"
echo "deployed bundle for the new code, confirm verify_jwt is still false, and"
echo "re-run the walk on Funding Circle expecting ~15.14 (Jul) / ~15.38 (Aug)."
echo "Session 264 had a function report deployed that had never booted."
exit $rc
