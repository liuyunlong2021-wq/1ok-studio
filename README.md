# One OK Studio

> 漫剧制作，一个就够。

One OK Studio 是一个本地运行的 AI 漫剧制作工具：从剧本、角色/场景/道具资产、分镜，到图片、视频、配音和成片导出，都在你自己的电脑上完成。

## 环境要求

- macOS 12+、Windows 10+ 或 Linux
- Python 3.11+、Node.js 18+、FFmpeg、Git

## 安装

```bash
git clone https://github.com/liuyunlong2021-wq/1ok-studio.git
cd 1ok-studio
cp .env.example .env
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
cd frontend && npm install && cd ..
```

Windows 使用 `py -3.11 -m venv .venv` 和 `.venv\\Scripts\\pip install -r requirements.txt`，后续将 `.venv/bin/python` 替换为 `.venv\\Scripts\\python`。

## 配置模型 API

编辑根目录 `.env`，填入你自己的 Key。`.env` 不会被提交到 GitHub。

```dotenv
DASHSCOPE_API_KEY=你的阿里云百炼Key
JIUCAIHEZI_API_KEY=你的韭菜盒子Key
JIUCAIHEZI_BASE_URL=https://api.jiucaihezi.studio
```

不同模型需要不同服务商的 Key；不使用的服务可以留空。API Key 会产生对应服务商的费用，请不要把自己的 `.env` 发给别人。

## 启动

终端一：

```bash
.venv/bin/python -m uvicorn src.apps.comic_gen.api:app --reload --port 17177 --host 0.0.0.0
```

终端二：

```bash
cd frontend && npm run dev
```

浏览器打开 `http://localhost:3008`；API 文档为 `http://localhost:17177/docs`。

## 数据和素材位置

- 项目配置：浏览器本地存储
- 上传素材和生成结果：项目根目录 `output/`
- 应用设置和日志：`~/.lumen-x/`

每位用户的数据和素材保存在自己的电脑上，不会自动上传到你的服务器。配置 OSS 后，生成媒体还可以同步到云端存储。

## 常见问题

页面打不开时，确认前后端两个终端都在运行，并检查端口：

```bash
lsof -nP -iTCP:3008 -sTCP:LISTEN
lsof -nP -iTCP:17177 -sTCP:LISTEN
```

生成失败时，检查 `.env` 中对应服务商的 API Key、余额和模型权限，再查看后端终端日志。Windows 找不到 FFmpeg 时，将 FFmpeg 加入系统 PATH，并用 `ffmpeg -version` 验证。

## 更新

```bash
git pull
cd frontend && npm install && cd ..
```

更新前请备份 `output/` 和重要项目数据。

## 版本

当前版本：**1.0.0**

## License

本项目基于 MIT License。上游项目与第三方模型服务仍受各自许可证和服务条款约束。
