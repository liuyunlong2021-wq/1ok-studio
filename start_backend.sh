#!/bin/bash

# 阿里云服务不走代理（避免PAC配置被Python忽略）
# macOS系统代理会被requests库读取，但PAC规则不会被解析
# 显式设置NO_PROXY确保阿里云域名直连
export NO_PROXY="*.aliyuncs.com,localhost,127.0.0.1"
export no_proxy="*.aliyuncs.com,localhost,127.0.0.1"

echo "========================================"
echo "Starting Backend (FastAPI)..."
echo "Port: 17177"
echo "Proxy Bypass: *.aliyuncs.com"
echo "========================================"

# 数据目录：后端所有 output/ 相对路径都以此为根（与打包 App 保持一致）
DATA_DIR="${ONEOKSTUDIO_DATA_DIR:-$HOME/.1okstudio}"
mkdir -p "$DATA_DIR"
cd "$DATA_DIR"

# uvicorn 需要从仓库根目录 import src.*，所以用 --app-dir 而不是切回仓库
REPO_DIR="$(cd "$(dirname "$0")" && pwd)"

# 启动 uvicorn
# cwd 是数据目录 ⇒ 不指定 --reload-dir 的话 --reload 只盯数据目录，改 src/ 永远不重启。
exec python -m uvicorn --app-dir "$REPO_DIR" --reload-dir "$REPO_DIR" --reload --port 17177 --host 0.0.0.0 src.apps.comic_gen.api:app

