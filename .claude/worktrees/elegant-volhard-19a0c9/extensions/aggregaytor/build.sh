#!/bin/bash
# Build the Aggregaytor Chrome extension.
# 1. Vite bundles TS entry points into dist/
# 2. This script copies static assets into dist/

set -e
cd "$(dirname "$0")"

echo "Building extension with Vite..."
npx vite build

echo "Copying static assets..."
cp manifest.json dist/
cp -r sidepanel dist/
cp -r popup dist/
mkdir -p dist/icons
if [ -d icons ] && [ "$(ls -A icons 2>/dev/null)" ]; then
  cp icons/* dist/icons/
fi

echo "Extension built to dist/"
echo "Load as unpacked extension from: $(pwd)/dist"
