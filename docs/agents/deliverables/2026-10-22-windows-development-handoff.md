# Windows 开发交接（2026-10-22）

## 分支与工作进度

- 仓库：`https://github.com/liuyunlong2021-wq/1ok-studio.git`
- 继续开发分支：`1016-xinliubu`。当前进度没有合并到 `main`。
- 本次迁移保存六步手动生产流程的后续调整、资产提取与角色换装绑定、内置 H3 / Seedance Skill、工作台 UI，以及图片下载恢复功能。
- Mac 现有远程名为 `github`；新 clone 后默认远程名为 `origin`，无需为了名称一致而修改配置。

接手时先读根目录 `AGENTS.md`，再读：

1. `docs/agents/deliverables/2026-10-16-manual-six-step-production-tdd.md`
2. `docs/agents/deliverables/2026-10-16-engineering-asset-extraction-looks-tdd.md`
3. `docs/agents/deliverables/2026-10-17-image-task-recovery-upgrade-tdd.md`

## Windows 首次启动

准备 Git、Node.js 22 LTS、Python 3.11、FFmpeg。运行 Tauri 桌面壳还需 Rust 的 MSVC 工具链、Visual Studio C++ Build Tools 和 WebView2 Runtime。

在 PowerShell 中：

```powershell
git clone --branch 1016-xinliubu https://github.com/liuyunlong2021-wq/1ok-studio.git
cd 1ok-studio
npm ci
npm --prefix frontend ci
py -3.11 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
Copy-Item .env.example .env
# 在本机编辑 .env 填入自己的密钥，不提交该文件。
npm run tauri:dev
```

若已经 clone，请先确认 Windows 工作区没有需要保留的未提交修改，再执行 `git fetch origin`、`git switch 1016-xinliubu` 和 `git pull --ff-only`。已有 `.env` 时保留它，不重复执行上述复制命令。

前端默认 `http://localhost:3008`；Tauri 开发后端为 `http://localhost:17178`。

## 未解决事项：局域网 ComfyUI 接入

用户已选择让软件直接连接另一台 Windows 机器的 `comfy-adapter`，绕过 NewAPI。软件侧尚未实现此连接配置和调用路线，当前请求仍发往内置韭菜盒子网关；只修改 `.env` 中的网关地址不会生效。

下一步需要取得用户配置好的适配器局域网地址及 `/health` 结果，然后实现对应图片／视频调用。适配器配置约定：

```yaml
server:
  host: 0.0.0.0
  port: 9000
  public_base_url: http://<Windows局域网IP>:9000
comfy:
  base_url: http://127.0.0.1:8188
```

保留适配器自身鉴权，Windows 防火墙仅对所需局域网放行端口。适配器在另一个项目中，本仓库不包含它的源码、工作流和运行配置。

当前下载器拒绝 HTTP / 私网 URL。局域网接入需为用户明确配置的适配器地址增加受限的访问规则，并覆盖任务恢复路径，不能直接关闭现有 URL 校验。

已观察到的 NewAPI 图片错误在请求提交后约 1.43 秒返回 HTTP 500 `do_request_failed`；用户确认请求没有到达其 ComfyUI。客户端日志无法进一步确定上游连接失败原因。

图片恢复功能仅覆盖已保存产物 URL 后的下载失败。生成 POST 在返回产物 URL 前失败时，尚无法回捞。插件钩子禁止 JavaScript `async/await`，不等于宿主不能轮询异步上游；后续若继续改 NewAPI，应核对实际部署版本与任务协议，不能以该语法限制判断能力。

## 已验证与未验证

本次迁移前在 Mac 上验证：相关后端测试 94 项通过；前端逻辑测试 18 项、组件测试 28 项通过；前端类型检查通过。测试未调用付费生成接口。

Windows 构建和真实生成尚未验证；本次推送是开发进度交接，不是发行版。

## 不随 Git 迁移的内容

`.env`、用户配置、`output/` 项目数据库与素材、虚拟环境、依赖目录及构建产物均不随源码提交。要继续使用原有测试项目，应另行私下迁移数据并核对跨平台路径，密钥在目标电脑重新配置。

本地 `.raw/` 图片和空的 `jc-canvas/` 画布保留在 Mac，未提交到 GitHub。
