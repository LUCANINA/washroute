#!/usr/bin/env bash
# deploy-session-291.sh — deploy cs-signal-scan v2 (CS escalation detector).
# Run from the repo root:   bash deploy-session-291.sh
#
# FLAG DECISION (CLAUDE.md rule: the flag is a decision, never a default):
# cs-signal-scan was created on 2026-09-10 with verify_jwt: TRUE, and that was
# MEASURED after deploy — a POST with no Authorization header returned
#   401 {"code":"UNAUTHORIZED_NO_AUTH_HEADER"}
# which is the gateway answering, i.e. verify_jwt is on.
# verify_jwt: true  ->  append NOTHING. No --no-verify-jwt on this line.
#
# Re-measure before re-running this later:
#   curl -s -X POST https://umjpbuxrdydwejqtensq.supabase.co/functions/v1/cs-signal-scan \
#        -H 'content-type: application/json' -d '{}'
#   401 UNAUTHORIZED_NO_AUTH_HEADER = verify_jwt true = no flag.
set -euo pipefail
REF=umjpbuxrdydwejqtensq
npx -y supabase@latest functions deploy cs-signal-scan --project-ref $REF
echo
echo "Deployed. Now verify BY BEHAVIOUR (never infer from the push):"
echo "  bash verify-session-291.sh"
