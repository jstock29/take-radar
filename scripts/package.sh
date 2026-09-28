#!/usr/bin/env bash
# Build a Chrome Web Store upload: dist/take-radar-<version>.zip
set -euo pipefail
cd "$(dirname "$0")/.."

version=$(node -p 'require("./manifest.json").version')
out="dist/take-radar-${version}.zip"

files=(
  manifest.json
  background.js
  content.js
  names.js
  options.html
  options.js
  styles.css
  icons/icon-16.png
  icons/icon-48.png
  icons/icon-128.png
)

mkdir -p dist
rm -f "$out"
zip -q -X "$out" "${files[@]}"
echo "$out"
