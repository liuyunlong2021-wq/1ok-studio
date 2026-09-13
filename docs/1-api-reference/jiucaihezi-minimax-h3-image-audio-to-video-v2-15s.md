# 韭菜盒子 MiniMax H3 参考生视频 API 证据

- 来源：`/Users/by3/Documents/jiucaihezi-app/docs/wiki/运维/韭菜盒子MiniMax参考生视频API对外接入-2026-09-06.md`
- 核对日期：2026-09-06（契约升级：2026-09-12）
- 模型：`minimax_h3_image_audio_to_video_v2_15s`
- 接口：`POST /v1/videos`，`GET /v1/videos/{task_id}`，`GET /v1/videos/{task_id}/content`
- 提示词最多 12,000 字；时长 1–15 秒
- 分辨率：`480p竖`、`768p竖`、`480p横`、`768p横`
- 参考图最多 9 张；参考音频最多 3 段

## 2026-09-12 契约升级

- `POST /v1/videos` 毫秒级返回 `task_id`；参考素材转存与上游提交改为后台进行。
- 创建接口 4xx 返回结构化 `error.message`，可直接展示给用户。
- 轮询 `GET /v1/videos/{task_id}`：`queued` / `in_progress` 持续等待，直到 `completed` 或 `failed`；总等待上限 30 分钟。
- `failed` 时读取 `error.message`；素材类失败会指明具体素材主机。
- 成片必须经 `GET /v1/videos/{task_id}/content` 下载，轮询响应中的 `url` 字段不作为依据。
- 轮询超时或失败只重试轮询（复用同一 `task_id`），禁止重新创建任务，否则重复计费。
