#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

pnpm tauri build --bundles app

VERSION="$(node -p "require('./package.json').version")"
APP_PATH="$ROOT_DIR/src-tauri/target/release/bundle/macos/clawset-desktop.app"
OUTPUT_DIR="$ROOT_DIR/artifacts/macos"
ZIP_PATH="$OUTPUT_DIR/clawset-desktop_${VERSION}_aarch64.app.zip"
DMG_PATH="$OUTPUT_DIR/clawset-desktop_${VERSION}_aarch64.dmg"

if [ ! -d "$APP_PATH" ]; then
  echo "Missing app bundle: $APP_PATH" >&2
  exit 1
fi

mkdir -p "$OUTPUT_DIR"
rm -f "$ZIP_PATH" "$DMG_PATH"

ditto -c -k --sequesterRsrc --keepParent "$APP_PATH" "$ZIP_PATH"

STAGE_DIR="$(mktemp -d)"
trap 'rm -rf "$STAGE_DIR"' EXIT
cp -R "$APP_PATH" "$STAGE_DIR/"

hdiutil create -volname "Clawset Desktop" -srcfolder "$STAGE_DIR" -ov -format UDZO "$DMG_PATH"

echo "Generated macOS artifacts:"
echo "$ZIP_PATH"
echo "$DMG_PATH"
