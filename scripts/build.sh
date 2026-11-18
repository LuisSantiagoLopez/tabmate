#!/bin/sh
# Builds two zips in dist/:
#   tabmate-extension.zip  - for people: unzip, then "Load unpacked" the tabmate-extension folder
#   tabmate-webstore.zip   - for the Chrome Web Store: manifest.json at the zip root
set -eu
cd "$(dirname "$0")/.."
VERSION=$(node -p "require('./extension/manifest.json').version")
rm -rf dist && mkdir -p dist/stage
cp -R extension dist/stage/tabmate-extension
find dist/stage -name '.DS_Store' -delete
(cd dist/stage && zip -qrX ../tabmate-extension.zip tabmate-extension)
(cd dist/stage/tabmate-extension && zip -qrX ../../tabmate-webstore.zip .)
rm -rf dist/stage
echo "Built Tabmate $VERSION"
ls -l dist
