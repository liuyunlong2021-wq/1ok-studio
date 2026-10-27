# MiniMax H3 Director8 本地线路

采集日期：2026-10-12。公开模型 ID：`jc-minimax-h3-director8`。

来源为同机上游仓库 `jiucaihezi-app` 的 `docs/wiki/运维/本机ComfyUI-MiniMaxH3导演台8步接入-2026-10-12.md`、`newapi-plugins/comfy.plugin.js`、`src/runtime/creation/creationModelRegistry.ts` 和 `comfy-adapter/workflows/minimax-h3-director8.meta.json`。
统一网关指南：https://api.jiucaihezi.studio/site-assets/jiucaihezi-api-guide.html
Director 节点参考：https://github.com/AIMixer/ComfyUI_MiniMaxH3_Director/blob/main/README_EN.md

- 创建：`POST /v1/videos`，Bearer 认证。
- JSON：`model`、`prompt`、`duration`、`images`、`size`。
- `duration` 为数字，0.2–120 秒，默认 5，步进 0.1；不能转为整数。
- `images` 为 1–9 张公网图片 URL；本地图片先经网关临时上传。
- `size` 默认为 `736x1280`。支持尺寸以目录列出的上游预设为准，映射到 width/height。
- 工作流固定 8 步，生成音视频，并保留 Topaz 1.5× 后处理；size 指生成画布而非最终放大后的尺寸。
- 轮询：`GET /v1/videos/{task_id}`；下载：`GET /v1/videos/{task_id}/content`。

上游资料标记为部分合同：本地代码已经登记，生产插件启用、GPU 生成、下载和扣费尚未验收。本仓库据此实现接入并标记 preview，不代表已通过上游真实生成验收。规范原始档案和 Context Hub 的跨仓库推广仍需后续同步。
