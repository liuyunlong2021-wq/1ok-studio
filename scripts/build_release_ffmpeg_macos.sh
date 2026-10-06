#!/usr/bin/env bash
# Build the portable media tools used by the macOS installer.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="${ONEOK_MEDIA_BUILD_DIR:-$(mktemp -d /tmp/oneok-media.XXXXXX)}"
PREFIX="$WORK/prefix"
export MACOSX_DEPLOYMENT_TARGET=11.0
FFMPEG_VERSION=8.0.3
FFMPEG_SHA256=6136812ea6d4e68bdba27e33c2a94382711cdf4f8602ffef056ff792bd6f9818
X264_COMMIT=0480cb05fa188d37ae87e8f4fd8f1aea3711f7ee
PKG_CONFIG="${PKG_CONFIG:-$(command -v pkg-config || true)}"
if [ "$(uname -m)" != arm64 ] || [ -z "$PKG_CONFIG" ]; then
    echo 'Requires Apple Silicon and pkg-config on the build machine.' >&2
    exit 1
fi
mkdir -p "$WORK" "$PREFIX" "$ROOT/bin" "$ROOT/src-tauri/runtime/licenses/sources"
curl -fL --retry 3 "https://ffmpeg.org/releases/ffmpeg-$FFMPEG_VERSION.tar.xz" -o "$WORK/ffmpeg.tar.xz"
echo "$FFMPEG_SHA256  $WORK/ffmpeg.tar.xz" | shasum -a 256 -c -
tar -xf "$WORK/ffmpeg.tar.xz" -C "$WORK"
git clone https://code.videolan.org/videolan/x264.git "$WORK/x264"
git -C "$WORK/x264" checkout --detach "$X264_COMMIT"
cd "$WORK/x264"
./configure --prefix="$PREFIX" --enable-static --disable-cli --disable-opencl \
    --extra-cflags=-mmacosx-version-min=11.0 --extra-asflags=-mmacosx-version-min=11.0 \
    --extra-ldflags=-mmacosx-version-min=11.0
make -j8
make install
cd "$WORK/ffmpeg-$FFMPEG_VERSION"
PKG_CONFIG_PATH="$PREFIX/lib/pkgconfig" ./configure --prefix="$PREFIX" \
    --pkg-config="$PKG_CONFIG" --enable-gpl --enable-libx264 --disable-autodetect \
    --disable-shared --enable-static --disable-doc --disable-debug --disable-ffplay \
    --enable-videotoolbox --enable-audiotoolbox --enable-zlib --enable-bzlib \
    --extra-cflags="-mmacosx-version-min=11.0 -I$PREFIX/include" \
    --extra-ldflags="-mmacosx-version-min=11.0 -L$PREFIX/lib"
make -j8
cp ffmpeg ffprobe "$ROOT/bin/"
python3 "$ROOT/scripts/check_macos_compat.py" --max 11.0 "$ROOT/bin/ffmpeg" "$ROOT/bin/ffprobe"
cp COPYING.GPLv2 "$ROOT/src-tauri/runtime/licenses/FFmpeg-GPLv2.txt"
cp "$WORK/x264/COPYING" "$ROOT/src-tauri/runtime/licenses/x264-GPLv2.txt"
cp "$WORK/ffmpeg.tar.xz" "$ROOT/src-tauri/runtime/licenses/sources/ffmpeg-$FFMPEG_VERSION.tar.xz"
git -C "$WORK/x264" archive --format=tar.gz HEAD > "$ROOT/src-tauri/runtime/licenses/sources/x264-$X264_COMMIT.tar.gz"
cp "$ROOT/scripts/build_release_ffmpeg_macos.sh" "$ROOT/src-tauri/runtime/licenses/sources/build-media.sh"
echo "Portable media tools prepared in $ROOT/bin (source and licenses included)."
