#!/bin/bash
# 生成全平台应用图标（macOS .icns / Windows .ico / 各尺寸 png / Android / iOS）。
#
# 源图必须是「成品」方图：1024×1024、带透明通道、底板自己画成圆角。
# 系统不会替你裁圆角 —— 旧脚本拿 frontend/public/1ok-logo.png（896×1200、无透明通道）
# 用 sips -z 硬拉成方图，产物是满幅黑方块：macOS 26 会给非标准形状的图标套一层白色
# 圆角底板，Dock 里就成了「黑方块 + 白边」。
#
# 现在的源图 src-tauri/icons/icon-source.png 按 Apple 图标栅格生成：
# 1024 画布 / 底板 824×824 圆角 184 居中 / 四周留 100px 透明 / 盾牌占底板高约 82%。
#
# 用法：./create_icon.sh [可选的 1024×1024 源图]
set -euo pipefail
cd "$(dirname "$0")"

SOURCE="${1:-src-tauri/icons/icon-source.png}"
if [ ! -f "$SOURCE" ]; then
    echo "缺少源图：${SOURCE}（需要 1024×1024、带透明通道的成品方图）" >&2
    exit 1
fi

if command -v magick >/dev/null 2>&1; then
    read -r WIDTH HEIGHT ALPHA <<<"$(magick identify -format '%w %h %A' "$SOURCE")"
    echo "源图：${SOURCE}（${WIDTH}x${HEIGHT}, alpha=${ALPHA}）"
    [ "$WIDTH" = "$HEIGHT" ] || echo "警告：源图不是正方形，生成结果会被拉伸" >&2
    [ "$ALPHA" != "Undefined" ] || echo "警告：源图没有透明通道，圆角外侧会是实心方块" >&2
fi

npx tauri icon "$SOURCE"

echo "已更新 src-tauri/icons/（含 icon.icns、icon.ico、各尺寸 png、android/、ios/）"
echo "重新打包（./build_tauri_mac.sh）后生效；Dock 里若还显示旧图标：killall Dock"

