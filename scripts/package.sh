#!/usr/bin/env bash
# Zip the extension for the Chrome Web Store. Only files the extension
# actually loads go in; repo tooling, store assets and docs stay out.
set -euo pipefail
cd "$(dirname "$0")/.."

version=$(jq -r .version manifest.json)
out="dist/take-radar-${version}.zip"
mkdir -p dist
rm -f "$out"
zip -q -r -X "$out" manifest.json ./*.js ./*.html ./*.css icons lists -x '.*' '*/.*'
echo "$out"
