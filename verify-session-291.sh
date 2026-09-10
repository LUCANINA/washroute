#!/usr/bin/env bash
# verify-session-291.sh — prove cs-signal-scan v2 is live and the idempotency
# fix works. v1 shipped a bug where re-running the same window re-counted
# messages and ratcheted severity-3 from 2 to 5 on no new input. The whole
# point of this check is that a second identical run changes NOTHING.
set -euo pipefail
F="https://umjpbuxrdydwejqtensq.supabase.co/functions/v1/cs-signal-scan"
K="$(grep -o 'eyJ[A-Za-z0-9._-]*' admin-dashboard/index.html | head -1)"
S="${WR_INTERNAL_SECRET:-}"
if [ -z "$S" ]; then
  echo "Set the secret first, then re-run:" >&2
  echo '  export WR_INTERNAL_SECRET="...the wr_internal_auth secret..."' >&2
  echo "Get it from Supabase: select secret from wr_internal_auth;" >&2
  exit 1
fi

echo "== 1. gateway (expect 401 UNAUTHORIZED_NO_AUTH_HEADER) =="
curl -s -X POST "$F" -H 'content-type: application/json' -d '{}'; echo

echo "== 2. notify must be refused (expect 501) =="
curl -s -X POST "$F" -H "Authorization: Bearer $K" -H "apikey: $K" \
  -H "x-wr-internal: $S" -H 'content-type: application/json' \
  -d '{"mode":"notify"}'; echo

echo "== 3. dry run, 14 days =="
curl -s --max-time 170 -X POST "$F" -H "Authorization: Bearer $K" -H "apikey: $K" \
  -H "x-wr-internal: $S" -H 'content-type: application/json' \
  -d '{"mode":"dry","lookback_days":14}' | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['summary'], 'skipped:', d.get('skipped_already_seen'))"

echo "== 4. write, then write AGAIN. The second run must report 0 new signals =="
curl -s --max-time 170 -X POST "$F" -H "Authorization: Bearer $K" -H "apikey: $K" \
  -H "x-wr-internal: $S" -H 'content-type: application/json' \
  -d '{"mode":"write","lookback_days":14}' | python3 -c "import sys,json;d=json.load(sys.stdin);print('run 1:',d['summary'])"
curl -s --max-time 170 -X POST "$F" -H "Authorization: Bearer $K" -H "apikey: $K" \
  -H "x-wr-internal: $S" -H 'content-type: application/json' \
  -d '{"mode":"write","lookback_days":14}' | python3 -c "import sys,json;d=json.load(sys.stdin);print('run 2:',d['summary'],'skipped:',d.get('skipped_already_seen'))"
echo
echo "PASS = run 2 shows total 0 and a non-zero skipped_already_seen."
echo "FAIL = run 2 shows more severity_3 than run 1. Do NOT enable the cron if so."
