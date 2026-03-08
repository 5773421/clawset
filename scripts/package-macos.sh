#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

log() {
  printf '[package-macos] %s\n' "$*"
}

verify_drag_layout() {
  local root_dir="$1"
  local expected_app_name="$2"

  if [ ! -d "$root_dir/$expected_app_name" ]; then
    echo "Layout check failed: missing $expected_app_name under $root_dir" >&2
    exit 1
  fi

  if [ ! -L "$root_dir/Applications" ]; then
    echo "Layout check failed: missing Applications symlink under $root_dir" >&2
    exit 1
  fi

  if [ "$(readlink "$root_dir/Applications")" != "/Applications" ]; then
    echo "Layout check failed: Applications symlink target is not /Applications" >&2
    exit 1
  fi
}

verify_dmg_contents() {
  local dmg_path="$1"
  local expected_app_name="$2"
  local mount_dir
  mount_dir="$(mktemp -d)"

  if ! hdiutil attach "$dmg_path" -readonly -nobrowse -mountpoint "$mount_dir" >/dev/null 2>&1; then
    log "Skipping mounted DMG content verification because hdiutil attach is unavailable in this environment"
    rm -rf "$mount_dir"
    return 0
  fi

  verify_drag_layout "$mount_dir" "$expected_app_name"

  # Validate the app signature after round-tripping into DMG.
  codesign --verify --deep --strict --verbose=2 "$mount_dir/$expected_app_name" >/dev/null
  hdiutil detach "$mount_dir" >/dev/null 2>&1 || true
  rm -rf "$mount_dir"
}

pnpm tauri build --bundles app

VERSION="$(node -p "require('./package.json').version")"
APP_PATH="$ROOT_DIR/src-tauri/target/release/bundle/macos/clawset-desktop.app"
APP_NAME="$(basename "$APP_PATH")"
OUTPUT_DIR="$ROOT_DIR/artifacts/macos"
ZIP_PATH="$OUTPUT_DIR/clawset-desktop_${VERSION}_aarch64.app.zip"
DMG_PATH="$OUTPUT_DIR/clawset-desktop_${VERSION}_aarch64.dmg"
SIGN_IDENTITY="${MACOS_SIGN_IDENTITY:--}"
ENTITLEMENTS_PATH="${MACOS_ENTITLEMENTS_PATH:-}"

if [ ! -d "$APP_PATH" ]; then
  echo "Missing app bundle: $APP_PATH" >&2
  exit 1
fi

mkdir -p "$OUTPUT_DIR"
rm -f "$ZIP_PATH" "$DMG_PATH"

if command -v xattr >/dev/null 2>&1; then
  # Clean inherited attributes before signing to avoid accidental quarantine flags.
  xattr -cr "$APP_PATH" || true
fi

codesign_args=(--force --deep --sign "$SIGN_IDENTITY")
if [ -n "$ENTITLEMENTS_PATH" ]; then
  if [ ! -f "$ENTITLEMENTS_PATH" ]; then
    echo "MACOS_ENTITLEMENTS_PATH does not exist: $ENTITLEMENTS_PATH" >&2
    exit 1
  fi
  codesign_args+=(--entitlements "$ENTITLEMENTS_PATH")
fi
if [ "$SIGN_IDENTITY" != "-" ]; then
  codesign_args+=(--options runtime --timestamp)
fi

log "Signing app bundle with identity: $SIGN_IDENTITY"
codesign "${codesign_args[@]}" "$APP_PATH"

log "Verifying app bundle signature"
codesign --verify --deep --strict --verbose=2 "$APP_PATH"

ditto -c -k --sequesterRsrc --keepParent "$APP_PATH" "$ZIP_PATH"

WORK_DIR="$(mktemp -d)"
STAGE_DIR="$WORK_DIR/dmg-root"
HYBRID_BASE="$WORK_DIR/clawset-desktop-hybrid"
HYBRID_ISO_PATH="${HYBRID_BASE}.iso"
trap 'rm -rf "$WORK_DIR"' EXIT
mkdir -p "$STAGE_DIR"
cp -R "$APP_PATH" "$STAGE_DIR/"
ln -s /Applications "$STAGE_DIR/Applications"

log "Validating DMG staging layout"
verify_drag_layout "$STAGE_DIR" "$APP_NAME"

if ! hdiutil create -volname "Clawset Desktop" -srcfolder "$STAGE_DIR" -ov -format UDZO "$DMG_PATH"; then
  echo "hdiutil create failed; falling back to makehybrid + convert" >&2
  rm -f "$DMG_PATH"
  hdiutil makehybrid -hfs -iso -joliet -default-volume-name "Clawset Desktop" -ov -o "$HYBRID_BASE" "$STAGE_DIR"
  hdiutil convert "$HYBRID_ISO_PATH" -ov -format UDZO -o "$DMG_PATH"
fi

log "Verifying DMG checksum and content layout"
hdiutil verify "$DMG_PATH" >/dev/null
verify_dmg_contents "$DMG_PATH" "$APP_NAME"

echo "Generated macOS artifacts:"
echo "$ZIP_PATH"
echo "$DMG_PATH"
