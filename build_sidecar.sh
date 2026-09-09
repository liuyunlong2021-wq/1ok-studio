#!/usr/bin/env bash
# build_sidecar.sh — Package the Python backend into a standalone binary via PyInstaller
# Output: a fast core runtime plus an on-demand Demucs helper

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "╔═══════════════════════════════════════════════════╗"
echo "║  LumenX Studio — Python Sidecar Builder          ║"
echo "╚═══════════════════════════════════════════════════╝"
echo ""

# Detect architecture
ARCH=$(uname -m)
case "$ARCH" in
    arm64|aarch64) TAURI_ARCH="aarch64" ;;
    x86_64)        TAURI_ARCH="x86_64" ;;
    *)             echo "❌ Unsupported architecture: $ARCH"; exit 1 ;;
esac

BINARY_NAME="lumenx-backend"
DEMUCS_NAME="lumenx-demucs"
OUTPUT_DIR="src-tauri"

echo "→ Building for architecture: ${TAURI_ARCH}"
echo "→ Output: ${OUTPUT_DIR}/${BINARY_NAME}"
echo ""

# Ensure output directory exists
mkdir -p "$OUTPUT_DIR"

PYTHON="${SCRIPT_DIR}/.venv/bin/python"
if [ ! -x "$PYTHON" ]; then
    echo "❌ Project virtual environment not found. Run: python3 -m venv .venv"
    exit 1
fi

if ! "$PYTHON" -m PyInstaller --version &>/dev/null; then
    echo "→ Installing PyInstaller into .venv..."
    "$PYTHON" -m pip install pyinstaller
fi

# PyInstaller onefile extracts Python.framework at runtime. Sign collected
# binaries with the same identity Tauri uses or macOS library validation will
# reject the framework because its Team ID differs from the sidecar process.
SIGNING_IDENTITY="${APPLE_SIGNING_IDENTITY:-}"
if [ -z "$SIGNING_IDENTITY" ]; then
    SIGNING_IDENTITY="$(security find-identity -v -p codesigning 2>/dev/null \
        | sed -n 's/.*"\(Developer ID Application:.*\)"/\1/p' \
        | head -n 1)"
fi

PYINSTALLER_SIGNING_ARGS=()
if [ -n "$SIGNING_IDENTITY" ]; then
    echo "→ Signing sidecar libraries with: ${SIGNING_IDENTITY}"
    PYINSTALLER_SIGNING_ARGS=(--codesign-identity "$SIGNING_IDENTITY")
fi

# Build with PyInstaller
echo "→ Running PyInstaller..."
"$PYTHON" -m PyInstaller \
    --name "$BINARY_NAME" \
    --onedir \
    --console \
    --noconfirm \
    --clean \
    "${PYINSTALLER_SIGNING_ARGS[@]}" \
    --hidden-import=uvicorn \
    --hidden-import=uvicorn.logging \
    --hidden-import=uvicorn.loops \
    --hidden-import=uvicorn.loops.auto \
    --hidden-import=uvicorn.protocols \
    --hidden-import=uvicorn.protocols.http \
    --hidden-import=uvicorn.protocols.http.auto \
    --hidden-import=uvicorn.protocols.websockets \
    --hidden-import=uvicorn.protocols.websockets.auto \
    --hidden-import=uvicorn.lifespan \
    --hidden-import=uvicorn.lifespan.on \
    --hidden-import=fastapi \
    --hidden-import=pydantic \
    --hidden-import=starlette \
    --hidden-import=httptools \
    --hidden-import=dotenv \
    --hidden-import=yaml \
    --hidden-import=dashscope \
    --hidden-import=oss2 \
    --hidden-import=dashscope.audio.tts_v2 \
    --exclude-module=demucs \
    --exclude-module=torch \
    --exclude-module=torchaudio \
    --exclude-module=sympy \
    --add-data "src:src" \
    --add-data "config:config" \
    --distpath "$OUTPUT_DIR" \
    sidecar_entry.py

# Tauri's resource copier canonicalizes symlinks before copying. PyInstaller's
# macOS onedir layout uses framework symlinks, which then collide with their
# real targets. Materialize them once at build time.
MATERIALIZED_DIR="${OUTPUT_DIR}/${BINARY_NAME}.materialized"
rm -rf "$MATERIALIZED_DIR"
cp -RLp "${OUTPUT_DIR}/${BINARY_NAME}" "$MATERIALIZED_DIR"
rm -rf "${OUTPUT_DIR}/${BINARY_NAME}"
mv "$MATERIALIZED_DIR" "${OUTPUT_DIR}/${BINARY_NAME}"

echo "→ Building on-demand Demucs helper..."
"$PYTHON" -m PyInstaller \
    --name "$DEMUCS_NAME" \
    --onefile \
    --console \
    --noconfirm \
    --clean \
    "${PYINSTALLER_SIGNING_ARGS[@]}" \
    --collect-all=demucs \
    --hidden-import=demucs.separate \
    --distpath "$OUTPUT_DIR" \
    demucs_sidecar_entry.py

# Clean up PyInstaller artifacts
rm -rf build/ "${BINARY_NAME}.spec" "${DEMUCS_NAME}.spec" 2>/dev/null || true

echo ""
echo "✅ Sidecar runtime built: ${OUTPUT_DIR}/${BINARY_NAME}"
echo "   Size: $(du -sh "${OUTPUT_DIR}/${BINARY_NAME}" | cut -f1)"
echo "✅ Demucs helper built: ${OUTPUT_DIR}/${DEMUCS_NAME}"
echo "   Size: $(du -h "${OUTPUT_DIR}/${DEMUCS_NAME}" | cut -f1)"
