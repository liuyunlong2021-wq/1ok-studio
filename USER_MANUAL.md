# One OK Studio 用户手册

> 作者：星莲(StarLotus，张钧贺)

## 📋 目录

1. [快速开始](#-快速开始)
2. [API 密钥配置](#-api-密钥配置)
3. [通道说明](#-通道说明)
4. [日志查看](#-日志查看)
5. [常见问题](#-常见问题)

---

## 🚀 快速开始

### 首次启动（仅限应用打包方式）

1. **双击应用图标**启动 One OK Studio
2. 应用会自动打开**设置页面**
3. 按照提示完成 **API 密钥配置**

### 应用数据目录

所有用户数据存储在以下位置：

| 系统 | 路径 |
|------|------|
| macOS / Linux | `~/.1okstudio/` |
| Windows | `C:\Users\<用户名>\.1okstudio\` |

---

## 🔑 API 密钥配置

One OK Studio 使用阿里云灵积平台(DashScope)提供 AI 能力。

### 获取 API Key

1. 访问 [阿里云灵积平台](https://dashscope.aliyun.com/)
2. 登录您的阿里云账号（没有账号请先注册）
3. 进入 **控制台** → **API-KEY 管理**
4. 点击 **创建新的 API-KEY**
5. 复制生成的 API Key

### 在应用中配置

1. 启动 One OK Studio
2. 点击左上角 **设置图标** ⚙️
3. 找到 **DASHSCOPE_API_KEY** 输入框
4. 粘贴您的 API Key
5. 点击 **保存**

> ⚠️ **重要**：请妥善保管您的 API Key，不要泄露给他人。

---

## 🧩 通道说明

One OK Studio **只接韭菜盒子一个通道**：图像、视频、文本、配音全部走它，没有第三方存储或原厂直连。

- 素材与生成结果**本地优先**，先落盘到数据目录下的 `output/`；
- 每个模型支持的尺寸、参考图数量、时长由**内置的模型目录**决定，不需要你切换供应商；
- 不需要配置 OSS、Kling、Vidu 等第三方凭证。

### 必填

- `JIUCAIHEZI_API_KEY`（在「设置」里填写即可）

### 视功能而定

- `DASHSCOPE_API_KEY`：文本模型与配音（TTS）走它，用到这两类功能时必填。
- `JIUCAIHEZI_BASE_URL`：默认 `https://api.jiucaihezi.studio`，一般不用改。

---

## 📋 日志查看

当遇到问题时，日志文件可帮助排查原因。

### 日志文件位置

| 系统 | 路径 |
|------|------|
| macOS / Linux | `~/.1okstudio/logs/app.log` |
| Windows | `C:\Users\<用户名>\.1okstudio\logs\app.log` |

### 打开日志目录

**macOS**：
1. 打开 Finder
2. 按 `Cmd + Shift + G`
3. 输入 `~/.1okstudio/logs` 并回车

**Windows**：
1. 打开资源管理器
2. 在地址栏输入 `%USERPROFILE%\.1okstudio\logs`
3. 按回车

### 如何提交问题报告

如需技术支持，请提供：
1. **app.log** 文件（或其中的错误部分）
2. 操作步骤描述

---

## ❓ 常见问题

### Q: 为什么需要配置 API Key？

A: One OK Studio 通过韭菜盒子通道调用图像、视频模型，需要你的 Key 来验证身份并计费；文本与配音另外走阿里云百炼（DashScope）。

### Q: 生成失败如何排查？

1. 查看日志文件中的错误信息
2. 检查 API Key 是否过期或余额不足
3. 确认网络连接正常

### Q: 如何清理缓存？

删除 `~/.1okstudio/` 目录下的 `webview_storage` 文件夹，然后重启应用。

---

## 📞 获取帮助

如有问题，请联系本项目开发者 星莲（StarLotus，张钧贺） 或查看项目 README 文档。
