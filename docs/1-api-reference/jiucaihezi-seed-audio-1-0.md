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

## 四个容易踩的点

1. **`references` 不能是空数组。** 合同写的是 1–3 项，所以「不带参考音」时必须让
   整个 `metadata` 字段都不出现 —— 不是传 `[]`。实现里 `generate_audio()` 就是这样，
   `tests/test_audio_plan.py` 有断言钉住。

2. **临时素材 15 分钟失效。** 本地参考音频经 `/api/creations/uploads` 换成的 URL
   是临时的，所以**不能把转存结果持久化**：角色参考音存仓库内的
   `uploads/xxx` 相对路径，每次生成时现传。存成网关 URL 过一会儿就是死链。

   同一请求里不要混用图片参考和音频参考 —— 本合同只保证音频参考。

3. **合成前有一道文本内容审核，拦下来只回一句看不懂的英文。** 实测 2026-09-19：
   导演稿里一段肉搏描写（“两具魁梧躯体猛烈冲撞在一起……骨骼受力发出嘎吱脆响”）
   会让 **2262 字的整篇**被拒：HTTP 400，1 秒内返回（没进合成、也不计费），
   响应体是
   `{"error":{"message":"demo text audit failed","type":"seed_audio_error","code":"45001125"}}`。

   - 跟**参考音频无关**：带 1 段参考音打同一段文本，一样 400。
   - 也**不是长度/标点问题**：同等长度的填充文本照过；换行改全角空格、删中英文引号
     都不影响结果。审核是模型判定 —— 同一句删两个字就能从拦变过，逐词换掉
     「猛烈 / 粗暴 / 冲撞 / 躯体」全部无效，**只能整段改写**。
   - 可解的改法：把那段物理冲突描写换成声音层（木轮声 / 叫卖声 / 脚步与衣料摩擦）
     —— 改完整篇立刻 200 并真出音频。
   - 产品侧已收口：`generate_audio()` 会把这条错误翻成中文处置办法（同时保留上游原文），
     声音导演稿的默认提示词与 `AUDIO_PLAN_OUTPUT_CONTRACT` 都写明不许写这类细节。

   **为什么“垫一句语境”能治它**（同一晚实测）：把导演稿改成三段式 ——
   `本片内容：`（一句话交代题材与事件）+ `角色音色：` + `声音描述：` —— 同一集、
   同样内容，新版 **200 真出音频（595KB）**，而平铺直叙的旧版照旧 400。
   推断：开头先把「这是汉末历史剧的市集角力」说清楚，单看肢体描写就不会被读歪。
   三段式的提示词落在 `llm.py` 的 `DEFAULT_AUDIO_PLAN_PROMPT` 与
   `AUDIO_PLAN_OUTPUT_CONTRACT`。

4. **`DurationOutOfRange`（HTTP 402）是时长上限，而且会抖。** 实测 2026-09-19：
   同一段文本打到 1600 字前后，一会儿 200、一会儿 402；切片逐个试时
   1562 字过、1581 字被拒，直接拿 1600 字打又过了（出 883KB）。也就是说它不是
   硬性字符上限，而是模型**预测时长**偶尔超顶 —— **重发一次就能过**。
   - 合同里写的 `input` 上限 3000 字符是接口限制，不代表每次都能合成。
     导演稿实际稳妥区间在 **1500 字上下**，所以提示词里的目标是 ≤ 2500 汉字时
     要留好重试余地。

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
