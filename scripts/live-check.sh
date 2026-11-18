#!/bin/sh
# End-to-end check of what a real person gets: download the zip from the LIVE site (through the
# guided installer page), unzip it to a fresh folder, load that folder in Chromium and run every test.
# Usage: sh scripts/live-check.sh [baseUrl]   (default https://trytabmate.com)
set -u
cd "$(dirname "$0")/.."
BASE="${1:-https://trytabmate.com}"
DIR=$(mktemp -d /tmp/tabmate-live.XXXXXX)
echo "== 1. Download page (1440 + 390) and the real download from $BASE"
node tests/download-page.js "$BASE" --save-zip="$DIR/tabmate.zip"; PAGE=$?
echo "== 2. Unzip to a fresh folder, like a double-click"
mkdir -p "$DIR/tabmate" && unzip -q "$DIR/tabmate.zip" -d "$DIR/tabmate" || { echo "unzip failed"; exit 1; }
VER=$(node -p "require('$DIR/tabmate/manifest.json').version") || { echo "no manifest.json at the folder root"; exit 1; }
echo "   $DIR/tabmate has manifest.json, version $VER"
echo "== 3. All local suites against the downloaded folder"
TABMATE_EXT="$DIR/tabmate" node tests/all.js; ALL=$?
echo "== 4. Real public sites against the downloaded folder (3 tries each)"
TABMATE_EXT="$DIR/tabmate" node tests/real-sites.js; REAL=$?
echo
echo "download page: $([ $PAGE = 0 ] && echo PASS || echo FAIL)  local suites: $([ $ALL = 0 ] && echo PASS || echo FAIL)  real sites: $([ $REAL = 0 ] && echo PASS || echo FAIL)  version: $VER  folder: $DIR/tabmate"
[ $PAGE = 0 ] && [ $ALL = 0 ] && [ $REAL = 0 ]
