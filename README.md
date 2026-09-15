# One OK Studio

> 漫剧制作，一个就够。

One OK Studio 是一个本地运行的 AI 漫剧制作工具：从剧本、角色/场景/道具资产、分镜，到图片、视频、配音和成片导出，都在你自己的电脑上完成。

---

## 一、普通用户：装 App（推荐）

**不需要安装 Python、Node.js 或任何开发环境。**

### 系统要求

| 项目 | 要求 |
| --- | --- |
| 芯片 | Apple Silicon（M1 / M2 / M3 / M4） |
| 系统 | macOS 12 Monterey 或更高 |
| 磁盘 | 约 1 GB |

> 目前只发布 Apple Silicon 版本（原生 arm64，一份安装包覆盖全部 M 系列芯片）。Intel Mac 请走下面的「二、开发者」路线。

### 安装步骤

1. 到 Releases 下载 `One OK Studio_1.1.1_aarch64.dmg`
2. 双击打开，把 **One OK Studio** 拖进「应用程序」
3. 从「启动台」或「应用程序」启动

安装包已签名并公证，正常情况直接双击就能打开。若系统仍提示「无法验证开发者」，到 **系统设置 → 隐私与安全性** 点「仍要打开」。

### 首次启动：填 API Key

App 自带的只是一个外壳，**没有任何密钥**，生成类功能需要先配置你自己的 Key：

1. 打开左侧导航的 **设置**
2. 填入对应服务商的 Key 并保存

| 服务商 | 用途 |
| --- | --- |
| 韭菜盒子 | 图像、视频模型主通道 |
| 阿里云百炼 | 文本、配音等 |

不同模型走不同服务商，不用的可以留空。API Key 会产生对应服务商的费用，**不要把自己的 Key 发给别人**。

密钥存在 `~/.1okstudio/config.json`，不会随 App 升级丢失，也不会被打进安装包。

### 安装 FFmpeg（导出功能依赖）

视频合成、音频混流等需要 FFmpeg。为了控制安装包体积，当前版本**有意不内置** FFmpeg，需要你装一次：

```bash
brew install ffmpeg
```

装完重启 App，到 **设置 → 系统自检** 确认 FFmpeg 状态正常。若没装过 Homebrew，先看 https://brew.sh 。

### 启动的服务与端口

双击 App 会自动拉起本地后端，不需要你开终端：

| 内容 | 地址 |
| --- | --- |
| 界面 | App 窗口内 |
| 后端服务 | `http://127.0.0.1:17177`（仅监听本机） |
| 接口文档 | `http://127.0.0.1:17177/docs` |

---

## 二、开发者：从源码运行

### 环境要求

- macOS 12+、Windows 10+ 或 Linux
- Python 3.11+、Node.js 18+、FFmpeg、Git

### 安装

```bash
git clone https://github.com/liuyunlong2021-wq/1ok-studio.git
cd 1ok-studio
cp .env.example .env
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
cd frontend && npm install && cd ..
```

Windows 使用 `py -3.11 -m venv .venv` 和 `.venv\\Scripts\\pip install -r requirements.txt`，后续将 `.venv/bin/python` 替换为 `.venv\\Scripts\\python`。

### 配置 Key

开发态读根目录的 `.env`（**不读** `~/.1okstudio/config.json`，那是打包态用的），填入你自己的 Key。`.env` 已在 `.gitignore` 里，不会被提交到 GitHub。

```dotenv
DASHSCOPE_API_KEY=你的阿里云百炼Key
JIUCAIHEZI_API_KEY=你的韭菜盒子Key
```

不同模型需要不同服务商的 Key；不使用的服务可以留空。API Key 会产生对应服务商的费用，请不要把自己的 `.env` 发给别人。

> 网关地址由产品内置，**不可配置**：`JIUCAIHEZI_BASE_URL` 即使写在 `.env` 里也会被忽略（后端会主动把它从环境变量和已保存配置中清除），避免请求被指向其它地址。

### 启动

方式一，一条命令拉起前后端并在浏览器打开（内部会锚定数据目录）：

```bash
npm run dev
```

方式二，分别开两个终端，想看后端日志时更清楚：

```bash
# 终端一：后端
.venv/bin/python -m uvicorn src.apps.comic_gen.api:app --reload --port 17177 --host 127.0.0.1

# 终端二：前端
cd frontend && npm run dev
```

浏览器打开 `http://localhost:3008`，API 文档为 `http://localhost:17177/docs`。

跑桌面壳（Tauri），前后端一起拉起：

```bash
npm run tauri:dev
```

### 运行测试

```bash
.venv/bin/python -m pytest -q                            # 后端
cd frontend && npx vitest run --config vitest.config.mts  # 前端
cd frontend && npx tsc --noEmit -p tsconfig.json          # 前端类型检查
```

---

## 三、数据与备份

**所有数据都在 `~/.1okstudio/`，备份这一个目录就等于完整备份。**

```
~/.1okstudio/
├── config.json          # API Key 与应用设置（打包态）
├── logs/                # 日志，含 sidecar.log（后端起不来先看这里）
├── output/              # 全部业务数据
│   ├── projects.json    # 项目：剧本、角色/场景/道具资产、分镜
│   ├── series.json      # 系列与剧集
│   ├── library_assets.json    # 全局模板库（对所有项目生效）
│   ├── playground_history.json / playground_templates.json
│   ├── assets/ audio/ video/ export/ storyboard/ uploads/
│   └── *.json.bak       # 写入时的自动备份
└── webview_storage/     # 界面本地状态
```

几点值得知道的行为：

- **写入是原子的**：先写临时文件再改名，并保留一份 `.bak`。若 `projects.json` 损坏，程序会把它另存为 `projects.json.corrupt-<时间戳>`，而不是直接丢掉数据。
- **全局模板库**（`library_assets.json`）里的角色/场景/道具会作为最低层出现在**所有**项目里；项目列表里会标出来源（当前集 / 整个系列 / 全局模板库）。写操作会自动改到正确的层。
- 想换数据位置，设环境变量 `ONEOKSTUDIO_DATA_DIR`（默认 `~/.1okstudio`）。日志位置可用 `ONEOKSTUDIO_LOG_DIR`。
- 配置 OSS 后，生成的媒体可以同步到云端存储。

---

## 四、打包 macOS App（维护者）

```bash
uv venv .venv-release-macos11 --python 3.11
uv pip install --python .venv-release-macos11/bin/python -r requirements-macos-arm64.txt
bash build_tauri_mac.sh
```

一条命令完成：PyInstaller 打包后端 → 前端静态导出 → Tauri 构建 → 修复 Python.framework 符号链接 → macOS 11 兼容扫描 → 签名 → 公证 → staple → `spctl` 校验。产物在 `src-tauri/target/aarch64-apple-darwin/release/bundle/`。

前置条件：

- **Apple Silicon 机器**。arm64 发布包支持 macOS 11.0 及以上的 M 系列 Mac。
- 发布专用 Python 3.11 环境，必须按上面的 `requirements-macos-arm64.txt` 安装；构建脚本会拒绝任何最低系统高于 macOS 11 的内嵌二进制。
- 钥匙串里有 `Developer ID Application` 证书。
- notarytool 钥匙串 profile，默认名 `one-ok-studio`，可用 `APPLE_NOTARY_PROFILE` 覆盖。

没有证书时构建会在签名步骤失败 —— 这是刻意的，避免产出别人打不开的包。脚本最后用 `spctl` 强制校验，没通过公证不会算成功。

> **FFmpeg 暂不打包**（有意为之，不是待补项）。目前 `bundle.resources` 只含 `1okstudio-backend/` 和 `1okstudio-demucs`，安装包体积优先；代价是用户要自己 `brew install ffmpeg` 一次。程序按「包内 `_internal/bin/ffmpeg` → PATH → 系统常见安装位置」的顺序查找，以后若要改成免安装，只需把一份自带依赖的 ffmpeg 放进资源目录，无需改代码。

> **本产品不带自动更新，也没有「检查更新」入口**。升级方式是重新下载 DMG 覆盖安装（见「六、更新」）。`src-tauri/Cargo.toml`、`lib.rs`、`capabilities/default.json`、`tauri.conf.json` 里都已彻底移除 Tauri updater 插件，不要只填回配置——插件没注册时，capability 里残留 `updater:default` 会让构建直接失败。

> **⚠️ 名字已统一为 `1okstudio`（数据目录/环境变量/产物名/localStorage key），再改需要迁移**。它们对用户不可见，但改名会直接破坏已有数据或用户设置：
> - `~/.1okstudio` 数据目录 —— 再改名会让已有用户的数据「消失」，必须配迁移并兼容旧名。
> - 前端的 `localStorage` key（`1okstudio-settings` 等 7 个）—— 再改名会清空用户的主题与视图设置。
> - `1okstudio-backend` / `1okstudio-demucs` 产物名 —— 要同步改 `build_sidecar.sh`、`build_tauri_mac.sh` 与 `src-tauri/src/sidecar.rs` 里的路径，还有 `pipeline.py` 里找 demucs 助手的那处。
> - 环境变量名不能用 `1OKSTUDIO_` 开头（shell 不允许数字开头的标识符），所以是 `ONEOKSTUDIO_*`。
>
> 容易忘的一处：crate 改名后编译出的二进制名会跟着变，`build_tauri_mac.sh` 里那个 `pgrep` 守卫必须同时更新，否则它检测不到正在运行的 App，构建会直接覆盖运行中的文件。

## 五、常见问题

**App 打不开，提示「无法验证开发者」**
确认系统 ≥ macOS 12、芯片是 Apple Silicon。仍不行就到 **系统设置 → 隐私与安全性** 点「仍要打开」。

**点生成没反应，或报 Key 相关错误**
到 **设置** 检查对应服务商的 Key、余额和模型权限。源码运行时是 `.env`，打包态是 `~/.1okstudio/config.json`。

**导出视频失败**
基本都是 FFmpeg。到 **设置 → 系统自检** 看状态；缺了就 `brew install ffmpeg` 再重启 App。

**界面空白 / 一直转圈**
后端没起来。先看 `~/.1okstudio/logs/sidecar.log`。源码运行时再确认 17177 端口没被占用：

```bash
lsof -nP -iTCP:3008 -sTCP:LISTEN
lsof -nP -iTCP:17177 -sTCP:LISTEN
```

**端口被别的进程占了**
程序会自动清掉属于本应用的陈旧后端。如果占用者不是本应用，它会拒绝接管并保持窗口不显示数据 —— 这是为了避免把旧后端内存里的项目列表写回磁盘、覆盖你的真实数据。

## 六、更新

App：从 Releases 下载新版本，覆盖「应用程序」里的旧版即可，`~/.1okstudio/` 不受影响（`config.json` 和项目数据都不在 App 包里）。

源码：

```bash
git pull
.venv/bin/pip install -r requirements.txt
cd frontend && npm install && cd ..
```

无论哪种方式，升级前建议先备份整个 `~/.1okstudio/`。

## 版本

当前版本：**1.1.1**

## License

本项目基于 MIT License，详见 [LICENSE](LICENSE)。第三方模型服务受各自服务条款约束。

发行与支持均以本仓库为准：

| 内容 | 地址 |
| --- | --- |
| 源码与 Releases | https://github.com/liuyunlong2021-wq/1ok-studio |
| 问题反馈 | https://github.com/liuyunlong2021-wq/1ok-studio/issues |
