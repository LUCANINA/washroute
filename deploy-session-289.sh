#!/usr/bin/env bash
# deploy-session-289.sh — deploy the eight Bookkeeping functions changed in
# session 289 (CPA write access). Run from the repo root:
#
#     bash deploy-session-289.sh
#
# WHY A SCRIPT AND NOT A COPY-PASTE LINE
# CLAUDE.md's rule is that --no-verify-jwt is a DECISION, never a default, because
# session 281 shipped it pre-attached onto a verify_jwt:true function and turned
# that function's gateway off. Every flag below was chosen from that function's
# MEASURED verify_jwt, read from list_edge_functions on 2026-09-08, and each line
# records what was measured. If you re-run this later, re-measure first: a
# function whose verify_jwt has changed needs its line changed too.
set -euo pipefail
REF=umjpbuxrdydwejqtensq
D="npx -y supabase@latest functions deploy"

echo "== verify_jwt:false — flag REQUIRED (omitting it would switch the gateway ON) =="
$D loan-xero-post        --project-ref $REF --no-verify-jwt
$D loan-find-difference  --project-ref $REF --no-verify-jwt
$D loan-bundle           --project-ref $REF --no-verify-jwt
$D xero-payout-sync      --project-ref $REF --no-verify-jwt
$D xero-payout-coverage  --project-ref $REF --no-verify-jwt

echo "== verify_jwt:true — NO flag (session 283 measured that a bare deploy leaves true as true) =="
$D payroll-xero-post          --project-ref $REF
$D loan-ingest-statement      --project-ref $REF
$D loan-ingest-amortization   --project-ref $REF

echo
echo "Deployed. Deploy state is proven by BEHAVIOUR, not by this script exiting 0 —"
echo "come back to the session and it will probe each one."
