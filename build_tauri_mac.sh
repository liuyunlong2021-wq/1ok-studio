#!/usr/bin/env bash
# build_tauri_mac.sh — One-click build for LumenX Studio macOS app (.app + .dmg)
# Produces: src-tauri/target/release/bundle/dmg/LumenX Studio_*.dmg

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "╔═══════════════════════════════════════════════════╗"
echo "║  LumenX Studio — Tauri macOS Build               ║"
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

if pgrep -f 'One OK Studio\.app/Contents/MacOS/(lumenx-studio|lumenx-backend)' >/dev/null; then
    echo "❌ One OK Studio is running. Quit the app before rebuilding so its sidecar archive is not replaced in place."
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
npx tauri build --target "$TARGET"

APP_PATH="src-tauri/target/${TARGET}/release/bundle/macos/One OK Studio.app"
DMG_PATH="src-tauri/target/${TARGET}/release/bundle/dmg/One OK Studio_$(node -p "require('./src-tauri/tauri.conf.json').version")_${TARGET%%-*}.dmg"
NOTARY_PROFILE="${APPLE_NOTARY_PROFILE:-one-ok-studio}"

# Tauri notarizes automatically when Apple credentials are exported. Otherwise,
# use the local notarytool Keychain profile and fail instead of shipping a DMG
# that Gatekeeper will reject on another Mac.
if ! xcrun stapler validate "$DMG_PATH" &>/dev/null; then
    echo "→ Notarizing DMG with Keychain profile: ${NOTARY_PROFILE}"
    xcrun notarytool submit "$DMG_PATH" --keychain-profile "$NOTARY_PROFILE" --wait
fi

xcrun stapler staple "$APP_PATH"
xcrun stapler staple "$DMG_PATH"
xcrun stapler validate "$APP_PATH"
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
