#!/bin/sh
# Builds three zips in dist/:
#   tabmate.zip           - for people. Files at the zip root, so unzipping (double-click on Mac,
#                           Extract All on Windows) makes one folder called "tabmate" to pick in "Load unpacked".
#   tabmate-webstore.zip  - for the Chrome Web Store (same files, manifest.json at the root).
#   tabmate-extension.zip - the old layout (a tabmate-extension folder inside), kept so old links still work.
set -eu
cd "$(dirname "$0")/.."
VERSION=$(node -p "require('./extension/manifest.json').version")
rm -rf dist && mkdir -p dist/stage
cp -R extension dist/stage/tabmate-extension
find dist/stage -name '.DS_Store' -delete
(cd dist/stage/tabmate-extension && zip -qrX ../../tabmate.zip .)
cp dist/tabmate.zip dist/tabmate-webstore.zip
(cd dist/stage && zip -qrX ../tabmate-extension.zip tabmate-extension)
rm -rf dist/stage
echo "Built Tabmate $VERSION"
ls -l dist
