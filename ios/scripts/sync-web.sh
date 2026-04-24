#!/usr/bin/env bash
# Builds the Vite app and copies dist/ into ios/Resources/web/
# so the SwiftUI wrapper can serve it via the app:// scheme.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IOS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_DIR="$(cd "$IOS_DIR/.." && pwd)"
WEB_DEST="$IOS_DIR/Resources/web"

cd "$REPO_DIR"
echo "→ Building web bundle (pnpm build)"
pnpm build

echo "→ Clearing $WEB_DEST"
rm -rf "$WEB_DEST"
mkdir -p "$WEB_DEST"

echo "→ Copying dist/ → Resources/web/"
cp -R "$REPO_DIR/dist/." "$WEB_DEST/"
touch "$WEB_DEST/.gitkeep"

echo "✓ Web bundle synced. Build the Xcode project to pick up changes."
