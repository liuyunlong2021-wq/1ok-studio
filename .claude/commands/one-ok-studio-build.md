---
description: One OK Studio 桌面应用构建流程 - macOS DMG 和 Windows EXE 打包
---

# One OK Studio 桌面应用构建

此 skill 用于将 One OK Studio 打包为桌面应用分发包。

## 前置条件

**通用:**
- Python 3.11+
- Node.js 18+ (npm)
- FFmpeg

**macOS 额外:**
- Xcode Command Line Tools
- `brew install ffmpeg`（如未安装）

**Windows 额外:**
- PowerShell 5.1+
- Edge WebView2 Runtime

## macOS 构建 (.dmg)

### 1. 确保构建脚本有执行权限

```bash
chmod +x build_mac.sh
```

### 2. 执行构建

```bash
./build_mac.sh
```

**构建流程:**
1. 构建 Next.js 前端为静态文件 → `static/`
2. 创建 Python 虚拟环境
3. 安装 Python 依赖
4. 准备 FFmpeg 二进制
5. PyInstaller 打包为 .app
6. 创建 DMG 安装包

### 3. 输出位置

```
dist_mac/One OK Studio.app   # macOS 应用
dist_mac/One OK Studio.dmg   # DMG 安装包（分发用）
```

### 4. 测试

```bash
open "dist_mac/One OK Studio.app"
```

### macOS 常见问题

| 问题 | 解决方案 |
|------|---------|
| FFmpeg 未找到 | `brew install ffmpeg` |
| DMG 创建失败 | 卸载已挂载的 DMG: `hdiutil detach "/Volumes/One OK Studio"` |
| 签名错误 | 首次运行需右键→打开，绕过 Gatekeeper |

## Windows 构建 (.exe)

### 1. 在 PowerShell 中执行

```powershell
.\build_windows.ps1
```

**构建流程:**
1. 构建 Next.js 前端为静态文件
2. 创建 Python 虚拟环境
3. 安装 Python 依赖
4. 准备 FFmpeg
5. PyInstaller 打包为 .exe

### 2. 输出位置

```
dist_windows\One OK Studio.exe   # Windows 可执行文件
```

### Windows 常见问题

| 问题 | 解决方案 |
|------|---------|
| FFmpeg 未找到 | 下载 FFmpeg 放入 `bin\` 目录或添加到 PATH |
| PowerShell 执行策略 | 管理员 PowerShell: `Set-ExecutionPolicy RemoteSigned` |
| WebView2 错误 | 安装 Edge WebView2 Runtime |

## 推荐分发路径（Tauri 安装包）

上两节是 legacy 的 PyInstaller 单文件路径，留着本地调试用。对外分发走 Tauri，它把后端拆成两个产物：

- `1okstudio-backend` —— 常驻后端运行时，**排除** torch/demucs
- `1okstudio-demucs.exe` —— 按需触发的 Demucs helper，只有它携带 torch

**为什么必须拆**：`pipeline.py` 里有一处函数内的 `import demucs.separate`（找不到 sidecar 时的回落），而 PyInstaller 连函数内 import 也会分析 —— 所以 legacy 路径会把 torch 一起打进单文件 exe：体积上 GB，而且每次启动都要解包。

### macOS

```bash
./build_tauri_mac.sh
```

### Windows

```powershell
.\build_tauri_windows.ps1
```

前置：Rust（`cargo`）、Node、以及 `src-tauri/icons/`（由 `./create_icon.sh` 生成，缺了会回落成默认图标）。构建前必须先退出正在运行的 One OK Studio —— 脚本会检查。

`build_tauri_windows.ps1` 依次调用 `build_sidecar_windows.ps1`（产物落到 `src-tauri/`）、再跑 `npm --prefix frontend run build:tauri`、最后 `npx tauri build --bundles nsis`。首次构建会下载 NSIS 工具链，一段时间没动静是正常的。

输出位置:

```text
src-tauri/1okstudio-backend/     # onedir backend runtime (no torch/demucs)
src-tauri/1okstudio-demucs.exe   # on-demand Demucs helper (carries torch)
```

```text
src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/One OK Studio_<version>_x64-setup.exe
```

冒烟测试：装完后跑一次，在 sidecar 日志里确认出现 `Backend is ready!` 再发包。

## 构建产物清理

```bash
rm -rf dist/ dist_mac/ dist_windows/ build/ *.spec
rm -rf frontend/.next frontend/out static/
```

## 应用数据路径

打包后应用的用户数据存储在：
- **macOS/Linux:** `~/.1okstudio/`
- **Windows:** `C:\Users\<username>\.1okstudio\`

数据位置可用环境变量 `ONEOKSTUDIO_DATA_DIR` 覆盖。

包含：
- `config.json` — 配置（API Key 等）
- `logs/` — 运行日志

## Stable installer runtime contract

Users install and launch the app without installing Python, Node.js, Rust,
FFmpeg, pip packages, or WebView2 by hand. Online generation still requires
network access and the user's own API key in Settings.

The Tauri distribution includes the frozen Python runtime and modules, static
frontend, model catalog, built-in Skill packages, FFmpeg/FFprobe (including their
native libraries), the Demucs helper and its local htdemucs checkpoints.
Windows NSIS embeds the offline WebView2 installer. User projects, uploaded
Skills, media, `.env`, and API keys are never copied into the installer.

Build-machine inputs (these are not end-user setup steps):

- Install the platform release requirements into the release venv. The macOS
  pins keep torch and torchaudio at the same version.
- Provide `bin/ffmpeg` and `bin/ffprobe` (Windows: `.exe`), or point
  `ONEOK_FFMPEG_PATH` and `ONEOK_FFPROBE_PATH` at compatible native tools.
  The Tauri path collects their dynamic dependencies with PyInstaller. macOS
  release tools and all collected libraries must support the configured minimum
  macOS version; a Homebrew executable alone is not a portable runtime.
- Provide the checksummed htdemucs `.th` checkpoints in `bin/demucs-models/`, or
  set `ONEOK_DEMUCS_MODEL_REPO`. `prepare_release_runtime.py` reads the installed
  Demucs model bag, checks each required checkpoint checksum, and prepares a
  local model repo. Runtime separation uses this repo without downloading.
- Both Node lockfiles and Cargo.lock are versioned. The Tauri release scripts
  install Node dependencies with `npm ci` before building.

`build_sidecar.sh` / `build_sidecar_windows.ps1` run resource preparation before
freezing. Missing modules, media tools, checkpoints, or incompatible macOS
binaries fail the build. Prepared resources live in `src-tauri/runtime/` and
are bundled by the Tauri release scripts. `release-manifest.json` records
versions and resource hashes; `python-requirements.lock` captures the exact
transitive dependency versions of that build. These generated files contain no
user settings or secrets and are not source-controlled.

Release acceptance still requires launching the actual installer on a clean
machine, opening a new workspace, and exercising image reading, media probing,
composition, and offline audio separation. Source/dev success is not installer
acceptance. macOS additionally requires successful signing and notarization;
Windows must be built and accepted on Windows.
