# 韭菜盒子 Seed Audio 1.0 接入证据

- 来源：`/Users/by3/Documents/jiucaihezi-app/docs/wiki/运维/韭菜盒子SeedAudio1.0API对外接入-2026-09-04.md`
- 核对日期：2026-09-14
- 模型名：`seed-audio-1.0`（创作面板显示名是「豆包音频生成1.0」，**请求必须用 `seed-audio-1.0`**）
- 接口：`POST /v1/audio/speech`（Base URL `https://api.jiucaihezi.studio`）
- 认证：`Authorization: Bearer <JIUCAIHEZI_API_KEY>`

## 契约要点

| 项 | 值 |
| --- | --- |
| `input` | **必填**，1–3000 字符 |
| `response_format` | `mp3`(默认) / `wav` / `pcm` / `opus` / `ogg_opus` |
| `metadata.references` | **1–3 项**，本地音频先传临时素材接口换成 URL |
| 响应 | **音频二进制**（不是 JSON） |
| 错误 | JSON `{"error": {"message", "type", "code"}}` |

**不属于合同、不要依赖**：`voice`、`speed`、`n`、`stream` 等 OpenAI 语音接口字段。

## 两个容易踩的点

1. **`references` 不能是空数组。** 合同写的是 1–3 项，所以「不带参考音」时必须让
   整个 `metadata` 字段都不出现 —— 不是传 `[]`。实现里 `generate_audio()` 就是这样，
   `tests/test_audio_plan.py` 有断言钉住。

2. **临时素材 15 分钟失效。** 本地参考音频经 `/api/creations/uploads` 换成的 URL
   是临时的，所以**不能把转存结果持久化**：角色参考音存仓库内的
   `uploads/xxx` 相对路径，每次生成时现传。存成网关 URL 过一会儿就是死链。

   同一请求里不要混用图片参考和音频参考 —— 本合同只保证音频参考。

## 参考音频的两种传法

```json
"metadata": { "references": [ {"audio_url": "https://…/ref.wav"} ] }
"metadata": { "references": [ {"audio_data": "<RAW_BASE64，不带 data: 前缀>"} ] }
```

单条 `audio_data` 不超过 10 MiB。本项目统一用 `audio_url`（先转存）。

## 本项目的用法

- 唯一实现：`src/models/jiucaihezi.py::generate_audio()`
- 调用方一：Playground 的 t2a / r2a（`playground/service.py`）
- 调用方二：Studio 的「AI 配音」——视频任务带 `generate_audio=True` 时先生成一版
  音频再交给视频模型（`pipeline._generate_ai_sound`）
- 调用方三：「声音」步骤的全集声音（`pipeline.generate_episode_audio`）

**它的作用分两类**：给视频模型当参考音频，以及**给人听**——录一版整集声音，
人听完自己判断「哪几个分镜一组」、每段大约多少秒（视频模型单次上限 30 秒）。
后者不参与任何程序决策。
