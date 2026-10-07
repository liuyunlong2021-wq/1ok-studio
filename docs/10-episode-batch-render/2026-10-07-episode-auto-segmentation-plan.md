# 整集自动分段生成（编排层）方案

> 状态：**未开工**，本文是开工前的设计约定。
> 日期：2026-10-07 · 起因：用户看到 ComfyUI 的 `MiniMaxH3Director` 节点后提出
> 「能不能选中一整集，自动切成 10~12 秒一段，咔咔咔全出完再拼成一集」。

## 0. 一句话目标

**一个「整集生成」按钮**：取全集分镜 → 按 10~12 秒自动分段 → 后端串行逐段生成 →
全段完成后自动拼接成一集。把现在的 **2N+1 次操作变成 1 次**。

---

## 1. 来源节点与三层结论

参考节点是 ComfyUI 的 `MiniMaxH3Director`（用户提供的 workflow JSON，**未查源码**——
本机到 github 不通，结论都是从 JSON 反推）。

它把**一整集装进一个节点**：`timeline_data.segments[]` 里每段带
`prompt / refs / durationSec / continuityFromPrev`；段间靠
`continuityOverlapFrames: 5` + `continuityKeepTail: true` + `continuityMode: "guide"` +
`continuityRedraw: 0.1` 接上——**上一段尾 5 帧留着，下一段在这 5 帧上以 10% 重绘强度接着长**。
输出是 `images + audio + fps + frame_count` **一条流**（不是 N 个文件），音频由
`video_vae` + `audio_vae` 同次生成，天然对齐。`clear_vram_between_segments` 说明它是
**单机顺序**跑多段。

| 层 | 节点能力 | 我们能否做到 | 本版 |
| --- | --- | --- | --- |
| L1 编排 | 一次排完整集、每段自己的参考图、只重跑某几段 | ✅ **能做**（本文） | **做** |
| L2 衔接 | 重叠 5 帧 + 10% 重绘，接缝物理上不存在 | ⚠️ 有三条近似路线，需先决策（§8） | 不做 |
| L3 采样 | 本地权重、双 VAE 联合采样、一条 frames+audio 流 | ❌ **API 路线做不到**（无帧级控制、无 latent 传递） | 不做 |

**关键判断：L3 是物理差距，L1 是编排缺口。** 用户要的「咔咔咔出一整集」绝大部分价值在 L1。

---

## 2. 现状（已核实，带证据）

| 事实 | 位置 |
| --- | --- |
| 「段」的概念**已经存在**，提示词明确「原文时间码仅供定位，重排为本片段的相对时间」 | `src/apps/comic_gen/api.py:819` `_motion_prompt_user_message` |
| 本地拼装提示词（0 延迟、不走 LLM） | `src/apps/comic_gen/api.py:921` `assemble_motion_prompt` |
| ⚠️ LLM 那条路单次 **60~130 秒** | `src/apps/comic_gen/api.py:796` 注释 |
| 一次请求 = **一条**视频；多镜头靠 `source_frame_ids` 传连续区间 | `src/apps/comic_gen/pipeline.py:2411` `create_video_task` |
| 段时长 = 选中各镜 `duration` 相加 | `src/apps/comic_gen/storyboard_contract.py:23` |
| 拼接 = ffmpeg concat **硬切，无转场** | `src/apps/comic_gen/pipeline.py:3213` `merge_videos` |
| 连续性的零件**已有**：`jc-minimax-h3` 收 `first_frame`/`last_frame` | `src/models/jiucaihezi.py:683-685` |
| 尾帧提取接口**已有** | `POST /frames/{id}/extract_last_frame`（`api.py:4255` / `pipeline.py:2608`） |
| 参考图推导**只有前端**有 | `frontend/src/lib/segmentReferences.ts`（`VideoCreator.tsx:732` 调用） |
| 取图逻辑只有前端有 | `frontend/src/lib/characterImage.ts:45 characterImageUrl` / `:56 scenePropImageUrl` |
| **没有队列**：视频任务走 BackgroundTasks，一次提交 N 条**全部并发** | `api.py:3135` + `pipeline.py:228`（只有提示词限并发 2） |
| ⚠️ 后端启动会把 pending/processing 标 failed | `pipeline.py:258` `_recover_orphan_tasks` |
| 现状操作量 **2N+1**（逐镜生成 N + 逐镜挑 take N + Merge 1），无「全选」 | `VideoCreator.tsx` / `VideoAssembly.tsx:53` |

---

## 3. 本版范围

**做**：自动分段 → 串行队列 → 自动写 `selected_video_id` → 自动合并 → 进度与失败恢复。

**不做**：段间连续性（§8，需先决策）、本地推理（L3）、转场特效、成本预估与限额。

---

## 4. 分段算法

### 输入
`script.frames`（有序，每镜 `duration` 为整数秒、> 0）+ 模型的 `duration.min/max`。

### 规则
1. **不切开一个镜头**（段落边界只落在镜头边界上）。
2. 顺序贪心：累加到「再加一镜就超 `max`」或「已经达到 `target`」为止。
3. `target` 默认 **12 秒**（可配）；`max` 取模型上限（Fk MiniMax H3 = 15）。
4. 末尾一段若不足 `min`，先尝试并进前一段（合并后仍 ≤ `max` 才并），否则保留并告警。

```python
def plan_segments(frames, target, lo, hi):
    segs, cur = [], []
    for f in frames:
        if f.duration > hi:
            raise ValueError(f"镜头「{f.shot_size}…」时长 {f.duration}s 超过模型上限 {hi}s，请先拆镜")
        if cur and (sum(cur) + f.duration > hi or sum(cur) >= target):
            segs.append(cur); cur = []
        cur.append(f)
    if cur: segs.append(cur)
    if len(segs) > 1 and sum(segs[-1]) < lo:      # 尾巴太短 → 试着并进前一段
        merged = segs[-2] + segs[-1]
        if sum(merged) <= hi: segs[-2:] = [merged]
    return segs
```

### 边界情况

| 情况 | 处理 |
| --- | --- |
| 单镜时长 > 模型上限 | **报错指名该镜**，不给用户偷偷截断 |
| 单镜时长 < 模型下限 | 报错（该镜本身就不合法） |
| 全集总时长 < 下限 | 报错「内容太短」 |
| 一段参考图 > 9 张（Fk H3 上限） | 报错指名**第几段**，让其删镜或换模型 |
| 分镜缺 `duration` | 沿用 `storyboard_duration` 的既有报错（`storyboard_contract.py`） |
| 工程未同步 | 沿用 `require_synced_engineering`（`engineering_script.py:158`） |

---

## 5. 数据模型

挂到 `Script` 上（自动进 `output/projects.json`，复用现有 `_save_data()` 与签名响应，
**不新建文件**）：

```python
class RenderSegment(BaseModel):
    index: int                 # 段号，从 1 开始
    frame_ids: List[str]
    duration: int              # = 各镜 duration 相加
    reference_image_urls: List[str]   # 该段自己的参考图（按段内首次出现顺序）
    task_id: Optional[str]     # 生成出来的 VideoTask
    status: str                # pending | running | done | failed | skipped
    attempts: int
    error: Optional[str]

class EpisodeRenderJob(BaseModel):
    id: str
    model: str                 # 例如 ft-video-v1-77e8ee7a…（Fk MiniMax H3）
    ratio: str
    target_seconds: int        # 默认 12
    segments: List[RenderSegment]
    status: str                # running | done | failed | canceled
    created_at: float
    # 关键：抗重启的唯一依据
    current_segment: Optional[int]

class Script(...):
    render_jobs: List[EpisodeRenderJob] = []
```

**为什么必须落盘**：一集 10 段要跑几十分钟；`pipeline.py:258` 的
`_recover_orphan_tasks` 会在后端启动时把 pending/processing 一律标 failed。
job 不落盘，重启一次整集就废。

---

## 6. 执行器

### 为什么放后端而不是前端驱动
前端 `await` 循环实现最省事（`deriveSegmentReferences` 现成），但：
**关窗口就断、刷新就丢、进度只在浏览器内存里** —— 而「一集要跑半小时」正是本功能的核心场景。
所以放后端。

### 状态机（串行，并发恒为 1）

```
pending ──► running ──► done
   ▲            │
   │            ├─► failed(重试≤2) ──► 跳过，继续下一段
   │            └─► canceled
   └── retry（手动）

所有段 done/skipped ──► 自动调 merge_videos ──► job.status = done
```

每段一步：
1. 本地拼装提示词（**调 `assemble_motion_prompt` 的内部函数，不走 HTTP、不走 LLM**）
2. `pipeline.create_video_task(...)`（复用现有实现，不动它）
3. 轮询该 task 直到 `completed` / `failed`（复用 `poll_video_task` 那套）
4. 成功 → 写 `frame.selected_video_id`（该段**首镜**，与现有单段行为一致）→ 下一段

### 重启恢复
启动时扫描 `render_jobs` 里 `status == running` 的 job，逐段对账：
- 有 `provider_task_id` → **resume**（`pipeline.process_video_task(..., resume=True)`，不重复计费）
- 无上游号且状态是 pending → 重新提交
- 已 `done` → 跳过

### 并发
队列内串行 1。**不与手动单段提交抢锁**（手动路径现状不动），但队列运行时 UI 要提示「整集生成中」。

---

## 7. API 与 UI

| 端点 | 用途 |
| --- | --- |
| `POST /projects/{id}/episode_render` | 建 job。body：`model / ratio / target_seconds / frame_ids?`（空 = 全集）。返回分段预览 |
| `GET /projects/{id}/episode_render` | 进度：每段状态、当前段、汇总 |
| `POST /projects/{id}/episode_render/cancel` | 停止（不掐上游，只停本地队列） |
| `POST /projects/{id}/episode_render/segments/{index}/retry` | 重跑某段（**会再计费**，需二次确认） |

UI 放在**动作步骤**（`VideoGenerator.tsx`，用户的说法就是「动作那步」）顶部：
「整集生成」按钮 + 分段预览条（每段：时长 / 镜头数 / 状态）+ 一键重跑失败段。
`VideoAssembly` 不动（合并结果照旧出现在那里）。

---

## 8. L2 段间衔接（本版不做，先记着）

| 路线 | 做法 | 代价 |
| --- | --- | --- |
| **A 真衔接** | `jc-minimax-h3` 首尾帧 + `extract_last_frame` 抽尾帧当下一段首帧 | ⚠️ 它**只收 2 张图**，首尾帧占满后没有角色参考位 |
| **B Fk H3 首帧** | Fk 合同只有 `imageUrls/videoUrls/audioUrls`，`reference_videos.max = 0`，**没有首尾帧字段** | 「第一张图当首帧」是**未验证的上游行为**，需一次探测（几分钱） |
| **C 零风险兜底** | 接受硬切，用 ffmpeg xfade 藏切点 | 今天就加得上，但只是视觉缓解 |

建议 **A + C**：A 用于「同一场景连续动作」，C 兜所有段。B 先探测再定。

---

## 9. 要写的代码

| 件 | 动作 | 备注 |
| --- | --- | --- |
| `plan_segments()` | **新写**（纯函数） | 分段算法，独立可测 |
| Python 版 `deriveSegmentReferences` | **新写** | 镜像 `frontend/src/lib/segmentReferences.ts` 的规则（段内首次出现顺序、按 id 去重）|
| Python 版取图 | **新写（小）** | 镜像 `frontend/src/lib/characterImage.ts:45/56`，输出走现有 `_public_media_url` |
| 拼装提示词 | **抽出函数复用** | 把 `api.py:921` 内的三段拼装逻辑抽出来，队列直接调 |
| 队列 worker + 落盘 | **新写** | §6 |
| 启动对账 | **新写** | 挨着 `_recover_orphan_tasks`（`pipeline.py:258`）放 |
| 4 个端点 | **新写** | §7 |
| 前端按钮与进度 | **新写** | `VideoGenerator.tsx` |

**不动**：`create_video_task`、`merge_videos`、现有单段提交流程。

---

## 10. 成本与耗时

- **成本（Fk MiniMax H3，0.08 元/秒）**：12 秒/段 ≈ **0.96 元/段**；
  2 分钟一集 ≈ 10 段 ≈ **9.6 元**。（其他模型按各自单价重算。）
- **提示词**：本地拼装 **0 延迟**。⚠️ 绝不用 LLM 那条路（60~130s/段）。
- **生成耗时**：**待实测**（现在没有单段耗时数据）。跑通 3 段小集后回来补这一节。

---

## 11. 需要用户拍板的决策点

| # | 问题 | 默认 |
| --- | --- | --- |
| 1 | 段长目标 10 还是 12 秒？（模型上限 15） | **12** |
| 2 | 某段失败怎么办 | 自动重试 1 次 → 仍失败则**跳过并标记，继续跑**，最后汇总 |
| 3 | 跳过导致中间缺一段，还自动合并吗 | **不自动合并**，等用户补完再合 |
| 4 | 自动采用生成的 take 吗 | **是**（写 `selected_video_id`），但用户可在装配里改回 |
| 5 | 拼接用硬切还是加转场 | v1 **硬切**（与现状一致），转场另开 |
| 6 | 单镜超上限 | **报错指名该镜**，不偷偷截断 |

---

## 12. 验收清单

**单测**
- [ ] `plan_segments`：正好装满 / 超一镜 / 单镜超上限 / 尾巴太短 / 全集太短 / 单段
- [ ] 参考图推导：与前端 `deriveSegmentReferences` 结果一致（同输入同输出）
- [ ] 队列状态机：段失败重试、跳过、取消、**重启后对账**（有上游号 resume，不重复提交）

**端到端**
- [ ] 3 段小集：一次点击 → 3 段全出 → 自动合并 → 成片时长 = 各段之和
- [ ] 中途 kill 后端再启动 → 队列自动接着跑，且**没有重复计费**（上游号复用）
- [ ] 某段手动置失败 → 只重跑那一段，其他段不重跑
