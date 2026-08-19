#!/usr/bin/env bash
# Delete the accumulated temp-* Supabase edge functions.
#
# Written session 222 (2026-08-19). At that point there were 232 deployed edge
# functions, 134 of them one-off `temp-*` diagnostics left over from past sessions.
# 122 of those had verify_jwt=false, meaning anyone holding the (client-side, and
# therefore effectively public) anon key could invoke them. 29 of those were
# write-capable -- including functions that void Xero journals, post splits, and
# delete records.
#
# The Supabase MCP tooling has no delete-function capability, which is why this is a
# script you run rather than something Claude did directly. It uses the Supabase
# Management API with YOUR access token, which never leaves your machine.
#
# USAGE
#   1. Create a personal access token: https://supabase.com/dashboard/account/tokens
#   2. export SUPABASE_ACCESS_TOKEN=sbp_...
#   3. ./cleanup-temp-functions.sh              # dry run -- lists what WOULD be deleted
#   4. ./cleanup-temp-functions.sh --confirm    # actually deletes
#
# Safety: only ever touches slugs starting with `temp-`. Everything else is untouchable
# by construction -- the filter is applied before the delete loop, not inside it.

set -euo pipefail

PROJECT_REF="umjpbuxrdydwejqtensq"
API="https://api.supabase.com/v1/projects/${PROJECT_REF}/functions"
PREFIX="temp-"

if [[ -z "${SUPABASE_ACCESS_TOKEN:-}" ]]; then
  echo "ERROR: SUPABASE_ACCESS_TOKEN is not set."
  echo "Create one at https://supabase.com/dashboard/account/tokens then:"
  echo "  export SUPABASE_ACCESS_TOKEN=sbp_..."
  exit 1
fi

CONFIRM=false
[[ "${1:-}" == "--confirm" ]] && CONFIRM=true

echo "Fetching deployed functions..."
ALL_JSON="$(curl -sS -H "Authorization: Bearer ${SUPABASE_ACCESS_TOKEN}" "${API}")"

if ! echo "${ALL_JSON}" | python3 -c 'import json,sys; json.load(sys.stdin)' 2>/dev/null; then
  echo "ERROR: unexpected response from the Management API. Is the token valid?"
  echo "${ALL_JSON}" | head -c 400
  exit 1
fi

# Extract only temp-* slugs. Guard rail: the prefix filter lives here, once.
mapfile -t TARGETS < <(echo "${ALL_JSON}" | python3 -c "
import json,sys
fns = json.load(sys.stdin)
for f in sorted(fns, key=lambda x: x['slug']):
    if f['slug'].startswith('${PREFIX}'):
        print(f['slug'])
")

TOTAL="$(echo "${ALL_JSON}" | python3 -c 'import json,sys; print(len(json.load(sys.stdin)))')"
COUNT="${#TARGETS[@]}"

echo
echo "Deployed functions total : ${TOTAL}"
echo "Matching '${PREFIX}*'      : ${COUNT}"
echo "Will be left alone       : $((TOTAL - COUNT))"
echo

if [[ "${COUNT}" -eq 0 ]]; then
  echo "Nothing to do."
  exit 0
fi

if [[ "${CONFIRM}" != true ]]; then
  echo "DRY RUN -- these would be deleted:"
  printf '  %s\n' "${TARGETS[@]}"
  echo
  echo "Re-run with --confirm to delete them."
  exit 0
fi

echo "Deleting ${COUNT} functions..."
OK=0
FAIL=0
for slug in "${TARGETS[@]}"; do
  code="$(curl -sS -o /dev/null -w '%{http_code}' -X DELETE \
    -H "Authorization: Bearer ${SUPABASE_ACCESS_TOKEN}" \
    "${API}/${slug}")"
  if [[ "${code}" == "200" || "${code}" == "204" || "${code}" == "404" ]]; then
    echo "  ok      ${slug} (${code})"
    OK=$((OK + 1))
  else
    echo "  FAILED  ${slug} (${code})"
    FAIL=$((FAIL + 1))
  fi
done

echo
echo "Done. ${OK} deleted, ${FAIL} failed."
[[ "${FAIL}" -gt 0 ]] && exit 1 || exit 0
