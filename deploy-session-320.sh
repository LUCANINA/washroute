#!/usr/bin/env bash
# deploy-session-320.sh — redeploy admin-assistant (route tool now returns skipped_stops
# and explains what the stop counts mean, so the assistant stops filing false #414-style issues).
# Run from the repo root:   bash deploy-session-320.sh
#
# FLAG DECISION: admin-assistant measured 2026-09-28 — POST with no Authorization header
# returned 401 UNAUTHORIZED_NO_AUTH_HEADER, i.e. verify_jwt is ON -> no --no-verify-jwt flag.
set -euo pipefail
REF=umjpbuxrdydwejqtensq
npx -y supabase@latest functions deploy admin-assistant --project-ref $REF
echo
echo "Deployed. Check: ask the admin assistant 'how did routes go on Sep 23?' — it should report skipped stops."
