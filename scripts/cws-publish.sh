#!/usr/bin/env bash
# Upload a zip to an existing Chrome Web Store item and submit it for review
# (Chrome Web Store API v2). Checks the store first, so a version that's
# already published or submitted (for example by hand in the dashboard) is
# not uploaded again.
#
#   CWS_TOKEN=... CWS_PUBLISHER_ID=... CWS_EXTENSION_ID=... scripts/cws-publish.sh dist/x.zip
#
# Writes to $GITHUB_OUTPUT:
#   state=<store state>   e.g. PENDING_REVIEW, PUBLISHED
#   done=true             this version is now in the store (just submitted, or already there)
set -euo pipefail

zip=${1:?usage: cws-publish.sh <zip>}
: "${CWS_TOKEN:?}" "${CWS_PUBLISHER_ID:?}" "${CWS_EXTENSION_ID:?}"

item="publishers/${CWS_PUBLISHER_ID}/items/${CWS_EXTENSION_ID}"
api="${CWS_API:-https://chromewebstore.googleapis.com}"
auth=(-H "Authorization: Bearer ${CWS_TOKEN}")
version=$(unzip -p "$zip" manifest.json | jq -r .version)
out=${GITHUB_OUTPUT:-/dev/null}

# Google's errors are JSON; print the readable part on one line. (GitHub
# masks each line of the multi-line key secret, including bare "{" and "}",
# which blanked out raw JSON error bodies in the log.)
describe() {
  jq -r '[.error.status, .error.message] | map(select(. != null)) | join(": ")' <<<"$1" 2>/dev/null ||
    tr -d '{}' <<<"$1"
}

# call METHOD URL [curl args...]: prints the body; on HTTP >= 400 prints the
# error as a GitHub annotation and returns 1.
call() {
  local method=$1 url=$2
  shift 2
  local body status
  body=$(curl -sS -X "$method" "${auth[@]}" -w '\n%{http_code}' "$@" "$url")
  status=${body##*$'\n'}
  body=${body%$'\n'*}
  if ((status >= 400)); then
    echo "::error::${method} ${url##*/} failed with HTTP ${status}: $(describe "$body")" >&2
    return 1
  fi
  echo "$body"
}

# --- What does the store have already? -------------------------------------------

if ! status=$(call GET "${api}/v2/${item}:fetchStatus"); then
  echo "::error::Couldn't read the item's status. Check CWS_PUBLISHER_ID, and that the service account is added under Account in the dashboard."
  exit 1
fi
published=$(jq -r '.publishedItemRevisionStatus.distributionChannels[0].crxVersion // empty' <<<"$status")
submitted=$(jq -r '.submittedItemRevisionStatus.distributionChannels[0].crxVersion // empty' <<<"$status")
submitted_state=$(jq -r '.submittedItemRevisionStatus.state // empty' <<<"$status")
echo "Store: published ${published:-none}; submitted ${submitted:-none} ${submitted_state}"

if [[ "$(jq -r '.takenDown // false' <<<"$status")" == "true" ]]; then
  echo "::warning::The store reports this item as taken down. See the developer dashboard."
fi
if [[ "$(jq -r '.warned // false' <<<"$status")" == "true" ]]; then
  echo "::warning::The store reports a policy warning on this item. See the developer dashboard."
fi

if [[ "$published" == "$version" ]]; then
  echo "${version} is already published."
  echo "state=PUBLISHED" >>"$out"
  echo "done=true" >>"$out"
  exit 0
fi
if [[ "$submitted" == "$version" && "$submitted_state" =~ ^(PENDING_REVIEW|STAGED)$ ]]; then
  echo "${version} is already submitted (${submitted_state})."
  echo "state=${submitted_state}" >>"$out"
  echo "done=true" >>"$out"
  exit 0
fi
if [[ "$submitted_state" == "PENDING_REVIEW" ]]; then
  echo "::error::${submitted} is still in review, so ${version} can't be uploaded yet. Wait for the review to finish, or cancel it in the dashboard, then re-run this workflow."
  exit 1
fi

# --- Upload --------------------------------------------------------------------------

echo "Uploading ${zip}…"
res=$(call POST "${api}/upload/v2/${item}:upload" -T "$zip")
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
  echo "::error::Upload of ${version} did not succeed (state: ${state:-unknown})."
  exit 1
fi

# --- Submit ----------------------------------------------------------------------------

echo "Submitting ${version} for review…"
if ! res=$(call POST "${api}/v2/${item}:publish" -H 'Content-Type: application/json' -d '{}'); then
  echo "::error::${version} was uploaded as a draft, but submitting it failed (see above). This usually means the dashboard needs something first, such as justifications for new permissions or required listing fields. Fix that in the dashboard and submit the draft there; the next run will see it and just tag the release."
  exit 1
fi
state=$(jq -r '.state // "UNKNOWN"' <<<"$res")
echo "Submitted: ${state}"
echo "state=${state}" >>"$out"
echo "done=true" >>"$out"
