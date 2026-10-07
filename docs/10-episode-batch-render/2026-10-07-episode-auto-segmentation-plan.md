# 整集自动分段生成（编排层）方案

> 状态：**未开工**，本文是开工前的设计约定。
> 日期：2026-10-07 · 起因：用户看到 ComfyUI 的 `MiniMaxH3Director` 节点后提出
> 「能不能选中一整集，自动切成 10~12 秒一段，咔咔咔全出完再拼成一集」。

## 0. 一句话目标

**一个「整集生成」按钮**：分镜阶段就把全集切成段 → 后端串行逐段生成 →
全段完成后自动拼接成一集。把现在的 **2N+1 次操作变成 1 次**。

两条主线（2026-10-07 用户确认）：

1. **分段在「分镜阶段」就出好**，不在生成时临时算。分镜本来就是一条连续时间轴
   （`storyboard_contract.py:132-140` 强制镜头时间码连续、无重叠无空档），分段就是在
   这条轴上按镜头边界划线 —— 用户能提前看到「第 3 段 · 11 秒 · 3 个镜」并手动调边界。
2. **段间衔接靠文字继承位置关系**，不靠首尾帧：下一段的提示词里用文字写明
   「上一段结束时的站位 / 朝向 / 持物 / 光向 / 机位」。
   → 零额外计费、不占参考图槽位、对任意模型都有效（§7）。

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
| L2 衔接 | 重叠 5 帧 + 10% 重绘，接缝物理上不存在 | ⚠️ 只能**近似**：文字续接（§7）+ 可选首尾帧/转场（§10） | **做文字续接** |
| L3 采样 | 本地权重、双 VAE 联合采样、一条 frames+audio 流 | ❌ **API 路线做不到**（无帧级控制、无 latent 传递） | 不做 |

**关键判断**：L3 是物理差距（做不到）；L1 + L2 文字续接是编排与提示词问题（做得到，且不额外花钱）。
节点那种「接缝物理上不存在」我们给不了，但「观众看不出跳变」可以争取。

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
| 分镜时间码**强制连续、无重叠无空档** → 分段就是在这条轴上划线 | `src/apps/comic_gen/storyboard_contract.py:132-140` `validate_storyboard_frames` |
| 每镜 `duration` 真实数据 **100% 有值**（183/183 实测） | `~/.1okstudio/output/projects.json` |
| ⚠️ `blocking.stage` / `lighting` / `transition_hint` 结构化字段**真实填充率 0%** | 同上实测；`llm.py:633` 解析处逐字段显式构造，技能不产出这些键 |
| 分镜技能**已要求**跨镜一致，但只是散文要求、不是字段 | `skills/engineering-screenplay/SKILL.md:120`、`skills/storyboard-inline-camera/SKILL.md:146` |
| r2v 流程的分镜步骤是 `storyboard_r2v`（`storyboard` 是 legacy 那条） | `frontend/src/components/project/ProjectClient.tsx:258-262` |

---

## 3. 本版范围

**做**

- **分镜阶段**：自动分段 + 手动调边界 + 每段「接续句」可编辑（§4 / §6 / §7）
- **生成阶段**：串行队列 + 自动写 `selected_video_id` + 自动合并 + 进度与失败恢复（§8 / §9）

**不做**

- 首尾帧真衔接（`jc-minimax-h3` 只收 2 图 / Fk 未验证）→ §10 列为可选
- 转场特效（除 §10 的 xfade 兜底选项）
- 本地推理（L3）
- 成本预估与限额

---

## 4. 分段放在分镜阶段

### 为什么放这儿
分镜是**一条连续时间轴**：契约强制镜头时间码连续、无重叠、无空档
（`storyboard_contract.py:132-140`），每镜 `duration` 实测 183/183 都有值。
所以「时间轴 + 每段长度」在分镜阶段就完全成立 —— 分段不是生成期的临时计算，
而是分镜本身的一部分。

### 分镜阶段要做的事
1. **默认自动分段**：按段长目标（默认 12 秒）贪心划，切点只落在镜头边界（算法见 §5）。
2. **可见**：分镜列表按段分组显示，每段标「第 3 段 · 11 秒 · 3 镜」。
3. **可手改**：把某镜并入上一段 / 拆出来；改段长目标后一键重排。
4. **每段一句「接续句」**：这段**结束时**的状态（下一段的起点继承），先生成草稿、用户可改（§7）。
5. **过期提示**：分镜增删镜或改时长后，旧方案标记「需重排」，生成前必须先重排或确认。

---

## 5. 分段算法

### 输入
`script.frames`（有序，每镜 `duration` 为整数秒、> 0）+ 段长目标 + 模型的 `duration.min/max`。

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

## 6. 数据模型（两层：分段方案 + 生成运行）

两层寿命不同，**不要合并**：段边界是分镜的产物（分镜改一次就要重排），运行状态是每次点
「整集生成」的产物（历史记录不该被改写）。都挂到 `Script` 上 —— 自动进
`~/.1okstudio/output/projects.json`，复用现有 `_save_data()` 与签名响应，**不新建文件**。

### 层 1：分段方案（分镜阶段产出，长期存在、用户可编辑）

```python
class Segment(BaseModel):
    index: int                    # 段号，从 1 开始
    frame_ids: List[str]          # 这一段包含哪些镜头（连续）
    duration: int                 # = 各镜 duration 相加
    exit_state: str = ""          # 「接续句」：本段结束时的站位/朝向/持物/光向/机位（§7）
    storyboard_revision: Optional[int] = None   # 绑定分镜版本，用于判断是否要重排

class Script(...):
    segment_target_seconds: int = 12   # 段长目标（分镜阶段可改）
    segments: List[Segment] = []
```

`storyboard_revision` 复用 `Script` 上已有的 `storyboard_source_revision` 语义
（项目数据里已有这个字段），分镜一变就比对得出「分段方案已过期」。

### 层 2：一次生成运行（点「整集生成」才有）

```python
class RenderSegment(BaseModel):
    index: int                    # 对应 Segment.index
    task_id: Optional[str]        # 生成出来的 VideoTask
    status: str                   # pending | running | done | failed | skipped
    attempts: int
    error: Optional[str]

class EpisodeRenderJob(BaseModel):
    id: str
    model: str                 # 例如 ft-video-v1-77e8ee7a…（Fk MiniMax H3）
    ratio: str
    segments: List[RenderSegment]   # 与 Segment.index 一一对应
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

## 7. 段间衔接：文字继承（本版主路线）

### 思路

段 N+1 的提示词开头加一段「起点继承」：

```
上一段（第 3 段）结束时的状态：角色A 在画面左侧中景、面朝画面右侧、右肩微后撤；
角色B 在画面中间偏后、胸口起伏、嘴唇紧抿；摄影机仍在巷口一侧、胸高机位、未越轴；
左侧店铺青绿霓虹为侧光、右后方酒红霓虹勾勒头发。
本段从这一状态自然延续：不要重新交代环境、不要换机位方向、不要改变光向。
```

### 接续句从哪来（关键取舍）

| 来源 | 可行性 | 结论 |
| --- | --- | --- |
| 结构化字段 `blocking.stage`（zone/depth/facing/posture）+ `lighting` + `transition_hint` | 语义完美，但**真实数据填充率 0%**，分镜技能也不产出 | ❌ 不能依赖 |
| 机械截断末镜 `visual_description` | 会把上一段整段环境描写搬进下一段（上一段末镜可能是个特写），反而污染提示词 | ⚠️ 只做降级兜底 |
| **LLM 一次性为整集生成接续表**（每段 1~2 行，含站位/朝向/持物/光向/机位） | 输入 = 整集分镜，输出 = 每段一行。**整集 1 次调用**，不是每段 1 次 | ✅ **主路线** |

选 LLM 的理由：位置关系现在**只存在于自然语言里**（技能已要求它跨镜一致，
`engineering-screenplay/SKILL.md:120`），而「把一段散文压缩成状态要素」正是 LLM 擅长的、
机械规则做不好的事。整集只调一次，成本可忽略。

### 必须可编辑
接续表**存在 `Segment.exit_state` 上、UI 上可改**。这是最重要的兜底：
LLM 写错了、或剧情需要特殊处理时，用户改一句话就行，不用重做分镜、不用重跑视频。

### 拼装位置
`assemble_motion_prompt`（`api.py:921`）现在的块顺序是
**[画幅/时长] → [参考图N] → [一致性锁] → [镜头N]**。
新增一块插在 **[一致性锁] 之后、[镜头N] 之前**：**[起点继承]**。
—— 只动这一个函数，本地拼装、0 延迟、不碰 LLM 那条路。

### 诚实边界（必须写进验收）
- **能救**：切点处的站位、朝向、持物、光向、机位方向不突变。
- **救不了**：剪在半个动作中途、像素级连续、换场或剧烈位移。
  文字是「指导」不是「约束」，模型不保证严格遵循。
- 所以验收标准是「**人眼看不出跳变**」，不是「接缝消失」。
  真要接缝不见，只有 §10 的首尾帧（近似）或 L3 本地推理（真）。

---

## 8. 执行器

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
1. 本地拼装提示词（**调 `assemble_motion_prompt` 的内部函数，不走 HTTP、不走 LLM**）。
   段 N≥2 时把**上一段的 `exit_state` 作为 [起点继承] 块插进去**（§7）。
2. 按段的 `frame_ids` 推导参考图（§11 的 Python 版 `deriveSegmentReferences`）并核对数量上限
3. `pipeline.create_video_task(...)`（复用现有实现，不动它）
4. 轮询该 task 直到 `completed` / `failed`（复用 `poll_video_task` 那套）
5. 成功 → 写 `frame.selected_video_id`（该段**首镜**，与现有单段行为一致）→ 下一段

### 重启恢复
启动时扫描 `render_jobs` 里 `status == running` 的 job，逐段对账：
- 有 `provider_task_id` → **resume**（`pipeline.process_video_task(..., resume=True)`，不重复计费）
- 无上游号且状态是 pending → 重新提交
- 已 `done` → 跳过

### 并发
队列内串行 1。**不与手动单段提交抢锁**（手动路径现状不动），但队列运行时 UI 要提示「整集生成中」。

---

## 9. API 与 UI

### 分镜阶段（`StoryboardR2V.tsx`，r2v 的分镜工作台）

| 端点 | 用途 |
| --- | --- |
| `POST /projects/{id}/segments/plan` | 重排分段。body：`target_seconds`。返回每段（时长 / 镜头数 / 边界） |
| `PATCH /projects/{id}/segments/{index}` | 改边界（归哪几个镜）与 `exit_state`（接续句） |
| `POST /projects/{id}/segments/continuity` | **1 次 LLM** 为整集生成接续表，写回各段 `exit_state` |

UI：分镜列表按段分组（段头「第 3 段 · 11 秒 · 3 镜」）+ 拖边界 + 每段接续句可编辑 +
「重新分段」+ 过期提醒。

### 生成阶段（`VideoGenerator.tsx`，就是「动作那步」）

| 端点 | 用途 |
| --- | --- |
| `POST /projects/{id}/episode_render` | 建 job。body：`model / ratio / frame_ids?`（空 = 全集）。返回分段预览 |
| `GET /projects/{id}/episode_render` | 进度：每段状态、当前段、汇总 |
| `POST /projects/{id}/episode_render/cancel` | 停止（不掐上游，只停本地队列） |
| `POST /projects/{id}/episode_render/segments/{index}/retry` | 重跑某段（**会再计费**，需二次确认） |

UI：动作步骤顶部「整集生成」按钮 + 分段预览条（每段：时长 / 镜头数 / 状态）+ 一键重跑失败段。
`VideoAssembly` 不动（合并结果照旧出现在那里）。

---

## 10. 其它衔接路线（可选增强，本版不做）

文字续接（§7）是**主路线**；下面三条是能叠加上去的增强，各自独立。

| 路线 | 做法 | 代价 / 前置 |
| --- | --- | --- |
| **A 首尾帧真衔接** | `jc-minimax-h3` 收 `first_frame`/`last_frame`；用已有的 `extract_last_frame`（`pipeline.py:2608`）抽上一段尾帧当下一段首帧 | ⚠️ 它**只收 2 张图** —— 首尾帧占满后**没有角色参考图的位置**。适合单/双角色、场景连续的段 |
| **B Fk H3 首帧** | Fk 合同只有 `imageUrls/videoUrls/audioUrls`，`reference_videos.max = 0`，**没有首尾帧字段** | 「第一张图当首帧」是**未验证的上游行为**，需一次探测（几分钱）才能定 |
| **C 转场兜底** | 用 ffmpeg xfade 把切点溶解掉 | 今天就能加。**和文字续接是绝配**：接续句让两端构图接近后，溶解才不会糊 |

建议顺序：**先只上文字续接**（§7）→ 看实际跳变程度 → 再决定加 C（几乎零风险）还是 A/B（要探测）。

---

## 11. 要写的代码

| 件 | 动作 | 备注 |
| --- | --- | --- |
| `Segment` / `EpisodeRenderJob` 模型 | **新写** | 挂 `Script` 上（§6），不新建文件 |
| `plan_segments()` | **新写**（纯函数） | 分段算法（§5），独立可测 |
| 分段过期判定 | **新写（小）** | 复用 `Script.storyboard_source_revision` |
| 接续表生成（整集 1 次 LLM） | **新写** | 写回各段 `exit_state`（§7） |
| `[起点继承]` 块 | **改一处** | `api.py:921 assemble_motion_prompt` 加一个块，顺序见 §7 |
| Python 版 `deriveSegmentReferences` | **新写** | 镜像 `frontend/src/lib/segmentReferences.ts:53` 的规则（段内首次出现顺序、按 id 去重）|
| Python 版取图 | **新写（小）** | 镜像 `frontend/src/lib/characterImage.ts:45/56`，输出走现有 `_public_media_url` |
| 拼装提示词 | **抽出函数复用** | 把 `api.py:921` 内的拼装逻辑抽出来，队列直接调 |
| 队列 worker + 落盘 | **新写** | §8 |
| 启动对账 | **新写** | 挨着 `_recover_orphan_tasks`（`pipeline.py:258`）放 |
| 7 个端点 | **新写** | §9（分镜 3 个 + 生成 4 个） |
| 分镜阶段的分段 UI | **新写** | `StoryboardR2V.tsx` |
| 动作阶段的整集按钮与进度 | **新写** | `VideoGenerator.tsx` |

**不动**：`create_video_task`、`merge_videos`、现有单段提交流程、`StoryboardComposer`（legacy）。

---

## 12. 成本与耗时

- **成本（Fk MiniMax H3，0.08 元/秒）**：12 秒/段 ≈ **0.96 元/段**；
  2 分钟一集 ≈ 10 段 ≈ **9.6 元**。（其他模型按各自单价重算。）
- **每段提示词**：本地拼装 **0 延迟**。⚠️ 绝不用 LLM 那条路（60~130s/段，`api.py:796`）。
- **接续表**：整个一集 **1 次 LLM 调用**（不是每段一次），可忽略；失败也有机械兜底，不阻塞。
- **生成耗时**：**待实测**（现在没有单段耗时数据）。跑通 3 段小集后回来补这一节。

---

## 13. 需要用户拍板的决策点

| # | 问题 | 默认 |
| --- | --- | --- |
| 1 | 段长目标 10 还是 12 秒？（模型上限 15） | **12** |
| 2 | 某段失败怎么办 | 自动重试 1 次 → 仍失败则**跳过并标记，继续跑**，最后汇总 |
| 3 | 跳过导致中间缺一段，还自动合并吗 | **不自动合并**，等用户补完再合 |
| 4 | 自动采用生成的 take 吗 | **是**（写 `selected_video_id`），但用户可在装配里改回 |
| 5 | 拼接用硬切还是加转场 | v1 **硬切**；加 xfade 是 §10 的 C 路线，等看过实际跳变再定 |
| 6 | 单镜超上限 | **报错指名该镜**，不偷偷截断 |
| 7 | 分段边界改动后自动重排还是只提示？ | **只提示**（自动重排会悄悄改掉用户手调过的边界） |
| 8 | 接续句草稿用 LLM 还是机械兜底？ | **LLM**（整集 1 次）；LLM 不可用时退机械兜底，并标记「草稿」 |
| 9 | 接续句为空时还生成吗？ | **生成**（不阻塞），该段提示词里就没有 [起点继承] 块 |

---

## 14. 验收清单

**单测**
- [ ] `plan_segments`：正好装满 / 超一镜 / 单镜超上限 / 尾巴太短 / 全集太短 / 单段
- [ ] 参考图推导：与前端 `deriveSegmentReferences` 结果一致（同输入同输出）
- [ ] `[起点继承]` 块：段 1 不带、段 N≥2 带、接续句为空不带；且位置在 [一致性锁] 之后
- [ ] 分段过期：改分镜后 `segments` 被判为需重排
- [ ] 队列状态机：段失败重试、跳过、取消、**重启后对账**（有上游号 resume，不重复提交）

**端到端**
- [ ] 3 段小集：一次点击 → 3 段全出 → 自动合并 → 成片时长 = 各段之和
- [ ] 中途 kill 后端再启动 → 队列自动接着跑，且**没有重复计费**（上游号复用）
- [ ] 某段手动置失败 → 只重跑那一段，其他段不重跑
- [ ] **人眼验收**（最重要）：看完 3 段，判断接缝处是否「看不出跳变」。
      看不出 → 文字续接够用；看得出 → 再考虑 §10 的 C / A / B
