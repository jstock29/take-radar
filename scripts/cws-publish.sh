#!/usr/bin/env bash
# Upload a zip to an existing Chrome Web Store item and submit it for review
# (Chrome Web Store API v2).
#
#   CWS_TOKEN=... CWS_PUBLISHER_ID=... CWS_EXTENSION_ID=... scripts/cws-publish.sh dist/x.zip
set -euo pipefail

zip=${1:?usage: cws-publish.sh <zip>}
: "${CWS_TOKEN:?}" "${CWS_PUBLISHER_ID:?}" "${CWS_EXTENSION_ID:?}"

item="publishers/${CWS_PUBLISHER_ID}/items/${CWS_EXTENSION_ID}"
api="${CWS_API:-https://chromewebstore.googleapis.com}"
auth=(-H "Authorization: Bearer ${CWS_TOKEN}")

# call METHOD URL [curl args...]: prints the body, fails on HTTP >= 400.
call() {
  local method=$1 url=$2
  shift 2
  local body status
  body=$(curl -sS -X "$method" "${auth[@]}" -w '\n%{http_code}' "$@" "$url")
  status=${body##*$'\n'}
  body=${body%$'\n'*}
  if ((status >= 400)); then
    echo "::error::${method} ${url} failed with HTTP ${status}: ${body}" >&2
    return 1
  fi
  echo "$body"
}

echo "Uploading ${zip}…"
res=$(call POST "${api}/upload/v2/${item}:upload" -T "$zip")
echo "$res"
state=$(jq -r '.uploadState // empty' <<<"$res")

# Large uploads finish asynchronously; poll until they settle.
for _ in $(seq 1 30); do
  [[ "$state" == "IN_PROGRESS" ]] || break
  sleep 10
  res=$(call GET "${api}/v2/${item}:fetchStatus")
  state=$(jq -r '.lastAsyncUploadState // .uploadState // empty' <<<"$res")
  echo "Upload state: ${state}"
done

if [[ "$state" != "SUCCEEDED" ]]; then
  echo "::error::Upload did not succeed (state: ${state:-unknown}). If a version is already in review, wait for it to finish or cancel it in the dashboard." >&2
  exit 1
fi

echo "Submitting for review…"
res=$(call POST "${api}/v2/${item}:publish" -H 'Content-Type: application/json' -d '{}')
echo "$res"
echo "state=$(jq -r '.state // "UNKNOWN"' <<<"$res")" >>"${GITHUB_OUTPUT:-/dev/null}"
