#!/usr/bin/env bash
# build_tauri_mac.sh — One-click build for One OK Studio macOS app (.app + .dmg)
# Produces: src-tauri/target/release/bundle/dmg/One OK Studio_*.dmg

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# The first Apple Silicon Macs shipped with macOS 11. Every native component
# in the bundle is checked against this value before notarization.
export MACOSX_DEPLOYMENT_TARGET="${MACOSX_DEPLOYMENT_TARGET:-11.0}"

echo "╔═══════════════════════════════════════════════════╗"
echo "║  One OK Studio — Tauri macOS Build               ║"
echo "╚═══════════════════════════════════════════════════╝"
echo ""

# ─── Step 1: Check prerequisites ───
echo "→ Checking prerequisites..."

if ! command -v cargo &>/dev/null; then
    echo "❌ Rust/Cargo not found. Install via: curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh"
    exit 1
fi

if ! command -v node &>/dev/null; then
    echo "❌ Node.js not found."
    exit 1
fi

if ! command -v npx &>/dev/null; then
    echo "❌ npx not found."
    exit 1
fi

echo "  ✓ Rust $(rustc --version | awk '{print $2}')"
echo "  ✓ Node $(node --version)"
echo ""

if pgrep -f 'One OK Studio\.app/Contents/(MacOS/one-ok-studio|Resources/1okstudio-backend/1okstudio-backend)' >/dev/null; then
    echo "❌ One OK Studio is running. Quit the app before rebuilding."
    exit 1
fi

if [ -z "${APPLE_SIGNING_IDENTITY:-}" ]; then
    APPLE_SIGNING_IDENTITY="$(security find-identity -v -p codesigning 2>/dev/null \
        | sed -n 's/.*"\(Developer ID Application:.*\)"/\1/p' \
        | head -n 1)"
    export APPLE_SIGNING_IDENTITY
fi

# ─── Step 2: Build Python sidecar ───
echo "→ Step 2: Building Python sidecar..."
bash build_sidecar.sh
echo ""

# ─── Step 3: Build frontend for Tauri ───
echo "→ Step 3: Building frontend (static export for Tauri)..."
cd frontend
TAURI_BUILD=true npm run build
cd ..
echo "  ✓ Frontend built to frontend/out/"
echo ""

# ─── Step 4: Build Tauri app ───
echo "→ Step 4: Building Tauri application..."

# Determine target based on architecture
ARCH=$(uname -m)
case "$ARCH" in
    arm64|aarch64) TARGET="aarch64-apple-darwin" ;;
    x86_64)        TARGET="x86_64-apple-darwin" ;;
    *)             echo "❌ Unsupported architecture: $ARCH"; exit 1 ;;
esac

echo "  Target: ${TARGET}"
# Remove the legacy sidecar copied by the old externalBin layout; it occupies the
# path now used by the onedir resource folder. Leftover may be a file (old
# onefile build) or a directory (older OUTPUT_DIR), so -rf rather than -f.
rm -rf "src-tauri/target/${TARGET}/release/1okstudio-backend"
npx tauri build --target "$TARGET" --config '{"bundle":{"resources":["1okstudio-backend/","1okstudio-demucs"]}}'

APP_PATH="src-tauri/target/${TARGET}/release/bundle/macos/One OK Studio.app"
DMG_PATH="src-tauri/target/${TARGET}/release/bundle/dmg/One OK Studio_$(node -p "require('./src-tauri/tauri.conf.json').version")_${TARGET%%-*}.dmg"
NOTARY_PROFILE="${APPLE_NOTARY_PROFILE:-one-ok-studio}"
NOTARY_KEYCHAIN="${APPLE_NOTARY_KEYCHAIN:-$(security default-keychain -d user | tr -d '\"[:space:]')}"

# Tauri cannot copy PyInstaller's framework symlinks as resources, so the
# sidecar build materializes them. Restore the canonical framework layout in
# the final app before signing; notarization rejects the expanded aliases.
PYTHON_FRAMEWORK="${APP_PATH}/Contents/Resources/1okstudio-backend/_internal/Python.framework"
if [ -d "$PYTHON_FRAMEWORK/Versions" ]; then
PYTHON_FRAMEWORK_VERSION="$(python3 - "$PYTHON_FRAMEWORK" <<'PY'
import pathlib
import shutil
import sys

framework = pathlib.Path(sys.argv[1])
versions = [
    path.name
    for path in (framework / "Versions").iterdir()
    if path.is_dir() and not path.is_symlink() and path.name != "Current"
]
if len(versions) != 1:
    raise SystemExit(f"Expected one bundled Python framework version, found: {versions}")
version = versions[0]
for relative in ("Python", "Resources", "Versions/Current"):
    path = framework / relative
    if path.is_dir() and not path.is_symlink():
        shutil.rmtree(path)
    else:
        path.unlink(missing_ok=True)
(framework / "Python").symlink_to("Versions/Current/Python")
(framework / "Resources").symlink_to("Versions/Current/Resources")
(framework / "Versions/Current").symlink_to(version)
print(version)
PY
)"
fi

python3 scripts/check_macos_compat.py --max "$MACOSX_DEPLOYMENT_TARGET" "$APP_PATH"

if [ -n "${PYTHON_FRAMEWORK_VERSION:-}" ]; then
    codesign --force --options runtime --timestamp --sign "$APPLE_SIGNING_IDENTITY" \
        "$PYTHON_FRAMEWORK/Versions/$PYTHON_FRAMEWORK_VERSION/Python"
fi
codesign --force --options runtime --timestamp --sign "$APPLE_SIGNING_IDENTITY" "$APP_PATH"
codesign --verify --deep --strict --verbose=2 "$APP_PATH"

# The DMG created by `tauri build` contains the pre-normalized app. Recreate it
# from the signed final app using Tauri's generated DMG builder.
DMG_BUILDER="$(dirname "$DMG_PATH")/bundle_dmg.sh"
build_dmg() {
    rm -f "$DMG_PATH"
    "$DMG_BUILDER" \
        --volname "One OK Studio" \
        --volicon "$(dirname "$DMG_PATH")/icon.icns" \
        --window-size 660 400 \
        --icon-size 128 \
        --icon "One OK Studio.app" 180 170 \
        --hide-extension "One OK Studio.app" \
        --app-drop-link 480 170 \
        --codesign "$APPLE_SIGNING_IDENTITY" \
        "$DMG_PATH" \
        "$(dirname "$APP_PATH")"
}

build_dmg

# Tauri notarizes automatically when Apple credentials are exported. Otherwise,
# use the local notarytool Keychain profile and fail instead of shipping a DMG
# that Gatekeeper will reject on another Mac.
if ! xcrun stapler validate "$APP_PATH" &>/dev/null; then
    echo "→ Notarizing app with Keychain profile: ${NOTARY_PROFILE}"
    xcrun notarytool submit "$DMG_PATH" --keychain-profile "$NOTARY_PROFILE" \
        --keychain "$NOTARY_KEYCHAIN" --wait
    xcrun stapler staple "$APP_PATH"
fi

# Rebuild so the distributed DMG contains the physically stapled app, then
# notarize the final disk image because rebuilding changes its signature.
xcrun stapler validate "$APP_PATH"
build_dmg
echo "→ Notarizing final DMG with Keychain profile: ${NOTARY_PROFILE}"
xcrun notarytool submit "$DMG_PATH" --keychain-profile "$NOTARY_PROFILE" \
    --keychain "$NOTARY_KEYCHAIN" --wait
xcrun stapler staple "$DMG_PATH"
xcrun stapler validate "$DMG_PATH"
spctl -a -vv --type execute "$APP_PATH"
spctl -a -vv --type open --context context:primary-signature "$DMG_PATH"

echo ""
echo "╔═══════════════════════════════════════════════════╗"
echo "║  ✅ Build Complete!                               ║"
echo "╚═══════════════════════════════════════════════════╝"
echo ""
echo "Output:"
echo "  .app: src-tauri/target/${TARGET}/release/bundle/macos/"
echo "  .dmg: src-tauri/target/${TARGET}/release/bundle/dmg/"
echo ""

# List the output
ls -la "src-tauri/target/${TARGET}/release/bundle/dmg/" 2>/dev/null || echo "  (DMG not found — check build output above)"
