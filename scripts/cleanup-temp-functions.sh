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
# COMPATIBILITY: written for bash 3.2, which is what macOS still ships. No `mapfile`,
# no `readarray`, no associative arrays. (v1 of this script used `mapfile` and died
# instantly; v2 put a heredoc and a stdin redirect on the same `python3 -` invocation,
# so the JSON never reached Python. Both are fixed here, and the Python helper is now
# written to a temp file and invoked with real arguments so there is no stdin ambiguity
# left to get wrong.)
#
# USAGE
#   1. Create a personal access token: https://supabase.com/dashboard/account/tokens
#      NOTE: this is NOT the same as `supabase login`, which stores its own separate
#      CLI token. You need a personal access token here.
#   2. export SUPABASE_ACCESS_TOKEN=sbp_your_real_token_here
#   3. ./cleanup-temp-functions.sh              # dry run -- lists what WOULD be deleted
#   4. ./cleanup-temp-functions.sh --confirm    # actually deletes
#
# Safety: only ever touches slugs starting with `temp-`. Everything else is untouchable
# by construction -- the filter is applied once, before the delete loop, not inside it.

set -euo pipefail

PROJECT_REF="umjpbuxrdydwejqtensq"
API="https://api.supabase.com/v1/projects/${PROJECT_REF}/functions"
PREFIX="temp-"

if [[ -z "${SUPABASE_ACCESS_TOKEN:-}" ]]; then
  echo "ERROR: SUPABASE_ACCESS_TOKEN is not set."
  echo "Create one at https://supabase.com/dashboard/account/tokens then:"
  echo "  export SUPABASE_ACCESS_TOKEN=sbp_your_real_token_here"
  exit 1
fi

# Catch the placeholder being pasted verbatim. It happened, and the failure it caused
# downstream (an API error object being indexed as a list) was far more cryptic than
# it needed to be.
if [[ "${SUPABASE_ACCESS_TOKEN}" == "sbp_..." || ${#SUPABASE_ACCESS_TOKEN} -lt 20 ]]; then
  echo "ERROR: SUPABASE_ACCESS_TOKEN looks like a placeholder, not a real token:"
  echo "  \"${SUPABASE_ACCESS_TOKEN}\""
  echo "Get a real one at https://supabase.com/dashboard/account/tokens"
  exit 1
fi

CONFIRM=false
[[ "${1:-}" == "--confirm" ]] && CONFIRM=true

WORKDIR="$(mktemp -d)"
trap 'rm -rf "${WORKDIR}"' EXIT
BODY="${WORKDIR}/functions.json"
HELPER="${WORKDIR}/pick.py"

cat > "${HELPER}" <<'PY'
import json, sys

path, prefix = sys.argv[1], sys.argv[2]
try:
    with open(path) as fh:
        data = json.load(fh)
except Exception as e:
    sys.stderr.write("ERROR: response was not valid JSON: %s\n" % e)
    sys.exit(2)

# The Management API returns a LIST of functions on success. Anything else is an
# error payload -- say so plainly instead of dying on an index error later.
if isinstance(data, dict):
    msg = data.get("message") or data.get("error") or json.dumps(data)[:300]
    sys.stderr.write("ERROR: API returned an error rather than a function list:\n  %s\n" % msg)
    sys.exit(2)
if not isinstance(data, list):
    sys.stderr.write("ERROR: unexpected payload type: %s\n" % type(data).__name__)
    sys.exit(2)

picked = sorted(f["slug"] for f in data if str(f.get("slug", "")).startswith(prefix))
sys.stderr.write("Deployed functions total : %d\n" % len(data))
sys.stderr.write("%-24s : %d\n" % ("Matching '" + prefix + "*'", len(picked)))
sys.stderr.write("Will be left alone       : %d\n" % (len(data) - len(picked)))
print("\n".join(picked))
PY

echo "Fetching deployed functions..."
HTTP_CODE="$(curl -sS -o "${BODY}" -w '%{http_code}' \
  -H "Authorization: Bearer ${SUPABASE_ACCESS_TOKEN}" "${API}")"

if [[ "${HTTP_CODE}" != "200" ]]; then
  echo "ERROR: Management API returned HTTP ${HTTP_CODE}."
  echo "Response:"
  head -c 500 "${BODY}"; echo
  echo
  echo "A 401 here almost always means the token is wrong, expired, or is a CLI"
  echo "login token rather than a personal access token."
  exit 1
fi

SLUGS="$(python3 "${HELPER}" "${BODY}" "${PREFIX}")" || { echo "Aborted."; exit 1; }

# bash 3.2 has no mapfile -- read the newline-separated slugs into an array by hand.
TARGETS=()
while IFS= read -r slug; do
  [[ -n "${slug}" ]] && TARGETS+=("${slug}")
done <<< "${SLUGS}"

COUNT="${#TARGETS[@]}"
echo

if [[ "${COUNT}" -eq 0 ]]; then
  echo "Nothing to do."
  exit 0
fi

if [[ "${CONFIRM}" != true ]]; then
  echo "DRY RUN -- these would be deleted:"
  for slug in "${TARGETS[@]}"; do echo "  ${slug}"; done
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
  case "${code}" in
    200|204|404) echo "  ok      ${slug} (${code})"; OK=$((OK + 1)) ;;
    *)           echo "  FAILED  ${slug} (${code})"; FAIL=$((FAIL + 1)) ;;
  esac
done

echo
echo "Done. ${OK} deleted, ${FAIL} failed."
[[ "${FAIL}" -gt 0 ]] && exit 1
exit 0
