# 共享资产复用契约（跨集 / 跨系列 / 全局库）

> 2026-09-17 · 状态：待评审
> 相关：`docs/design/r2v-workflow-v2.md`（Q3 活引用 / Q8 Cast 分工 / Q6 Reconcile 时机）、
> `docs/design/r2v-workflow-v3-unified.md`

## 0. 一句话结论

三层资产池（集内 / 系列 / 全局库）**已经存在**，合并读取也**已经生效**。
缺的不是架构，而是三个"上去 / 下来 / 看得见"的入口，外加四个把它表现成
"资产乱套了"的实现 bug。**不需要**把存储结构改成引用式。

---

## 1. 现状事实（全部实测核对）

### 1.1 三个池子

| 池子 | 存储位置 | 归属字段 | 谁能看到 | 怎么进去 |
|---|---|---|---|---|
| 集内 | `projects.json` 的每个 Script | `script.characters/scenes/props` | **只有这一集** | 提取实体（默认落这里）、Legacy 资产库的「+ 新建」 |
| 系列 | `series.json` | `series.characters/scenes/props` | 该系列**全部集** | 新流程 Cast 的「+ Add」、系列详情页的角色/场景/道具页签、Reconcile 的"提升为新资产" |
| 全局库 | `library_assets.json` | `library.characters/scenes/props` | **全部项目**（不分系列） | 资产库页的「提升到全局」（deep-copy + 新 id） |

数据根在 `~/.1okstudio/output/`（`ensure_user_data_dir()` 在 api 导入时 chdir）。

### 1.2 读取：三层合并，按 **id** 去重

`pipeline.resolve_episode_assets_with_source()` —— 优先级 `Episode > Series > Global`，
`GET /projects/{id}` 会给每条资产打一个 `source: "episode" | "series" | "global"`。

**关键**：合并去重看的是 `id`，**不是名字**。所以「重名的两个资产不会自动合并」，
这是后面所有麻烦的根。

### 1.3 截图 2 那个「资产库」页是什么

`AssetLibraryPage`（`#/library`）在**前端**把三份数据拼起来展示：

```ts
Promise.all([api.listSeries(), api.getProjects(), api.listLibraryAssets()])
// AssetLibraryPage.tsx:110-112
```

它是**聚合浏览器，不是存储层**。卡片上的来源标签（`好看的` / `全局 / 共享`）
是前端按宿主算的，不看这个标签就无法知道资产真正住在哪一层。

### 1.4 写入 / 删除的真实路由（这是最容易出 bug 的地方）

| 动作 | 入口 | 实际写到哪 | 代码 |
|---|---|---|---|
| 提取实体 | 剧本步「提取实体」 | **集内**（整体替换本集三个列表） | `pipeline.reparse_project` |
| 新建资产 | 新流程 Cast「+ Add」 | **系列池**（有系列时） | `api.createSeriesAsset` |
| 新建资产 | Legacy 资产库「+ 新建」 | **集内** | `crudApi.createCharacter(projectId, …)` |
| 提升 | 资产库页 Inspector「提升到全局」 | **全局库（复制 + 新 id，原资产不动）** | `pipeline.promote_asset_to_library` |
| 反向 fetch | `POST /projects/{id}/assets/fork_from_library` | 全局库 → 集内（新 id） | **前端零调用（死端点）** |
| 删除 | Legacy 资产库卡片 | 按 `source` 路由 | `ConsistencyVault.tsx:204-231` |
| 删除 | 资产库页 Inspector | **仅 global 来源可删** | `AssetInspector.tsx:296` |

**「提升」是复制不是搬家**：`promote_asset_to_library` 用 `copy.deepcopy` + 新 uuid
追加到全局库，源资产原样留在原池（源码注释写明 "promotion is additive"）。
后果：提升之后，**同一个角色会在项目里出现两张卡**（系列那张 + 全局那张，id 不同
→ 合并不去重）。截图 2 里 `73号` 同时挂在「好看的」和「全局 / 共享」就是这一条。

### 1.5 已经写好但用户永远看不到的机制

`ReconcileModal`（跨集资产去重，含 `merge_into_series` 的帧引用改写）**只被
`ScriptProcessor.tsx` 挂载**，而 `ScriptProcessor` 在整个 app 里没有任何地方 import
（全仓库只有 3 处注释提到它）。事件由 `ProjectClient.tsx:284` 派发
`1okstudio:openReconcile`，**全仓库没有监听者**。

→ 这个功能从用户视角等于不存在，所以系列池永远是空的（实测：三国 0/0/0、
功夫女优 0/0/0；只有「好看的」4/2/3，是用户在系列详情页手工建的）。

### 1.6 你的项目走的是哪条 UI

`stepsForWorkflow()`：`workflowMode !== "r2v"` → `LEGACY_STEPS`。
实测四个系列的 `workflow_mode` 全是 `i2v_legacy`（前端新默认已是 `r2v`，
这四份数据早于那次改动）。所以：

- 你截图里那个「资产库 / 管理本项目的角色、场景与道具」= **ConsistencyVault**
  （`ProjectClient.tsx:258`，`activeStep === "assets"`）
- 新流程的 **Cast** 只在 `workflow_mode === "r2v"` 时出现
- 两个 UI 不是"新旧皮肤"，功能差异很大（见 §1.4 的写入路由）
- 目前**没有**工作流模式的事后切换工具（v3 文档列为"数据迁移复杂"）

**本文件的方案必须同时落到两个 UI**，否则你自己的三国系列用不上。

---

## 2. 用户视角看到的四个「不对」（实测）

### 2.1 三国第 1 集里冒出「73号」

不是提取错了。`73号` 是全库**唯一**一条全局资产（`char_09fd49…`，来自「好看的」），
因为三层合并对每个项目都生效，它会出现在**所有**项目里。
真正的问题是**界面上没有任何东西告诉你「这是全局资产」**——
ConsistencyVault 的卡片没有来源角标，只有删除时的 confirm 文案才提"全局模板库"。

### 2.2 那条 73号 显示成空图

全局 `73号` 的图在 `reference_sheet.image_variants` 里（`image_url` 是 null）。
- `Cast.resolveCharacterImage()` 会读 `reference_sheet` ✅
- `ConsistencyVault` 的卡片只读 `full_body_asset / image_asset / avatar_url / image_url`
  （`ConsistencyVault.tsx:929-937`），**不读 `reference_sheet`** ❌ → 显示占位图。

同一个资产在两个 UI 里长不一样，这是纯 bug。

### 2.3 删除删不掉（三个独立 bug）

1. **项目里删不掉全局资产** —— `pipeline._delete_asset()`：
   `if target is None or source == "global": raise ValueError(... not found in project)`
   （`pipeline.py:1243`）。全局资产在项目视图里可以看见，却没有合法删除路径。
2. **删系列资产会挑错集** —— `delete_series_asset()`：
   `episode = next((s for s in self.scripts.values() if s.series_id == series_id), None)`
   （`pipeline.py:1217`）拿"该系列的第一集"去删。资产其实属于**另一集**时
   `_find_asset_with_source` 找不到 → 报 not found。删一个刚在别的集建好的角色，
   必然失败。
3. **全局库删除有引用扫描，前端不传 force** —— `delete_library_asset(force=False)`
   在有分镜帧引用时抛 `LibraryAssetInUseError`（HTTP 409），
   而 `api.deleteLibraryAsset(type, id)` 只有两个参数（`api.ts:1560`），
   永远删不掉被引用过的全局资产。

### 2.4 原生弹窗显示 `[object Object]`

`ConsistencyVault.tsx:229` 等 16 个文件里都是这个形状：

```ts
alert(error.response?.data?.detail || error.message || "删除资产失败")
```

FastAPI 的 `detail` 在 422 校验失败时是**数组**、在自定义错误里可能是**对象**，
`alert()` 拿到非字符串就渲染成 `[object Object]`。用户看到的就是截图里那个弹窗。

---

## 3. 设计目标 / 非目标

**目标**
1. 资产做一次，同系列后续集**直接可用**（不重新生成、不重新上传）。
2. 用户的动作数：**一份资产一次**，不是"每集一次"。
3. 归属可见、可撤销：一眼看出这条资产住在哪一层，能上能下能删。
4. 不静默改数据：任何跨层移动都要用户确认。

**非目标（明确砍掉）**
- ❌ 把 `Script.characters` 改成"引用 + overrides"的引用式重构（迁移风险 > 收益）
- ❌ 按名字静默自动合并（`路人乙` / `汉朝小兵` / `73号` 必然误合并）
- ❌ embedding / 语义匹配
- ❌ 别名（alias）机制 —— 有价值但排到 P2 以后，先把手动路径做顺
- ❌ 改 `series.json` / `library_assets.json` 的存储 schema（P0/P1 零迁移）

---

## 4. 方案

### 4.1 归属可见（P0）

资产卡片加来源角标 + 一个筛选器：

```
┌──────────────────────┐
│ [系列] 刘备        ★ │   ← 系列池：本系列每集都看得到
│ [全局] 73号          │   ← 全局库：所有项目都看得到
│ [本集] 汉朝小兵      │   ← 集内：只有这一集
└──────────────────────┘
```

- 数据现成：`GET /projects/{id}` 已经返回 `source`，前端**一次都没用**。
- 角标同时是操作入口（见 4.3/4.4）。
- 加一个「只看本集」开关，让"这集自己提取出来的"与"借来的"分开看。

### 4.2 「上去」：提升入口（P0）

两条语义**必须分开**，现在的实现把两者混成了"复制"：

| 动作 | 语义 | 实现 |
|---|---|---|
| **提升到系列** | 集内 → 系列池：资产离开本集，本集改为引用系列那条（帧引用要改写） | 已有 `merge_into_series` 的帧改写逻辑可复用，只差 UI |
| **提升到全局库** | 系列/集内 → 全局库 | 已有 `promote_asset_to_library` |

**改动**：`promote_asset_to_library` 现在只"复制"，导致提升后重复两份。
改为「移动 + 改写帧引用」：目标池插入（**沿用原 id**，不要发新 id），源池删除，
并把所有引用该 id 的帧保持指向（id 不变 → 无需改写）。**id 不变**是关键，
否则"提升一次，项目里多一张卡"。

> 若担心"提升后想回退"，用一次性的 undo 提示，而不是留一份副本。

### 4.3 「下来」：关联入口（P0，用户自己点）

这是用户要的核心动作：**我已经有刘备了，这个刘玄德就是刘备。**

入口位置（用户点，不自动弹）：

```
资产库顶部：  [ + 新建资产 ]  [ ⇄ 关联已有资产 ]  [ 与系列对齐 ]  [ 同步描述 ]
```

点「关联已有资产」→ 选中本集这条 → 弹选择器：

```
┌─ 关联到已有资产 ─────────────────────────────┐
│ 当前：本集 / 刘玄德        （无图）           │
│ 搜索：[ 刘备                          ]      │
│ ┌────────────────────────────────────────┐  │
│ │ [图] 刘备          系列 · 三国     ◉ 选  │  │
│ │ [图] 73号          全局 / 共享     ○     │  │
│ │ [图] 刘备          集内 · 三国 第1集 ○    │  │
│ └────────────────────────────────────────┘  │
│            [ 取消 ]   [ 关联（合并本集这条）] │
└──────────────────────────────────────────────┘
```

- 候选池 = `系列池 ∪ 同系列其他集的集内池 ∪ 全局库`（**现在只有系列池**，
  所以你"第一集和第九集同一个场景"匹配不到 —— 第九集还没建）。
- 确认后执行 `merge`: 把本集这条删掉，`frame.character_ids / scene_id / prop_ids`
  里指向本集 id 的全部改写成目标 id。后端逻辑已经在
  `reconcile_apply` 的 `apply_list()` 里写好了，**只需要让 target 支持 series/global**。
- 列表排序：名字完全匹配 → 同类型 → 有图的优先。
- 反向动作「取消关联（fork）」用现成的 `fork_library_asset_to_project`：
  把引用改成一条独立副本，避免误改全局资产。**这个端点前端零调用，要接上。**

### 4.4 「与系列对齐」（P0，复用已有 Reconcile）

把已经写好但没挂载的 `ReconcileModal` 接到资产库顶部按钮上（用户自己点，不自动弹）：

- 挂载点：`ProjectClient`（两个 UI 都能覆盖）或资产库组件内部。
- 顺手扩匹配池：`reconcile_suggestions` 现在只跟 `series.characters` 比，
  改成 `系列 ∪ 同系列其他集 ∪ 全局库`，返回 `target_kind`。
- `src` 认领顺序改成"有图的优先"，`_name_match_confidence` 先不动（P2 再谈别名）。

### 4.5 删除语义（P0，需要一次决策）

| 资产来源 | 项目内「删除」应该做什么 |
|---|---|
| 集内 | 真删（现状正确） |
| 系列 | 真删系列池那条 + 清掉该系列**所有集**的帧引用。**不能挑"第一集"** |
| 全局库 | 二选一：<br>**(a)** 从全局库删除（走 `delete_library_asset`，带引用扫描和 409 提示）<br>**(b)** 只在本项目隐藏（不推荐的隐式隐藏，容易让人以为删掉了） |

建议 **(a)**，但 confirm 文案必须升级为：「这条资产来自**全局库**，删除会影响
**所有项目**」+ 列出引用方（后端已经有 `_scan_library_asset_references`，409 的响应里
就带 referrer 列表）。真正"只想在本集去掉"的场景走 4.3 的关联/替换。

前端要传 `force` 才有第二条路：先把 409 的 referrer 列表渲染成确认框，
用户点"仍然删除"再带 `force=true` 重发。

### 4.6 写入路由：默认归属（P1）

现状是「提取出来的都落集内」。既然 v2 已经定了
**"Series 优先：角色/场景/道具以 Series 为真相所在地"**，就应该让
「提取实体」在**有系列时默认写系列池**（同名同名沿用已有 id，不同名则新增到系列池）。

- 集内池保留给"本集特有的一次性资产"（群演、路人）。
- 提供开关：「本集新实体默认入库位置：系列 / 本集」。
- 这条做完，4.3 的关联需求会自然下降一个数量级（因为大部分实体第一次就落对了层）。

### 4.7 提取时喂名册（P1）

`parse_novel()` 现在**完全不知道已有资产**（system prompt 里没有实体清单）。
把「系列池 ∪ 全局库」的 `名字 + 一句话描述` 注入实体提取 prompt，
要求**沿用已有名字**：

> 本系列已有角色：刘备（汉室宗亲，蓄须）、张飞（豹头环眼）……
> 若正文出现同一人物，请直接使用已有名字，不要起新名。

这比事后匹配便宜得多，也是唯一能防住「没胡子的少年（张飞）」这类名字漂移的办法。

---

## 5. 实施计划

> **进度（2026-09-17）**：**P0 九项已全部落地**。
> 删除语义按用户拍板选 **(a) 真从全局库删掉**（弹窗列出引用方，二次确认后强删）；
> 「关联」入口按用户拍板做成 **用户自己点**（资产卡片上的按钮 + 资产库顶部「与系列对齐」），
> 提取后不再自动弹窗。

### P0 · 让现有能力可用（不改存储结构）

| # | 内容 | 文件 | 类型 | 状态 |
|---|---|---|---|---|
| 1 | 资产卡片加来源角标 | `ConsistencyVault.tsx`、`lib/assetSourceLabel.ts` | 新 UI | ✅（标签共用 `assetSource` 命名空间）；「只看本集」筛选待做 |
| 2 | 挂「与系列对齐」入口并接活 `ReconcileModal` | `modules/ReconcileAction.tsx`、`ConsistencyVault`、`Cast` | 接死代码 | ✅ 用户自己点 |
| 3 | 关联选择器：候选池 = 系列 ∪ 全局 ∪ 本集 ∪ 同系列其它集 | `pipeline.list_asset_candidates`、`modals/AssetLinkDialog.tsx` | 新功能 | ✅ |
| 4 | 「取消关联」= 在本集 fork 一份独立副本 | `pipeline.fork_library_asset_to_project`、卡片「独立一份」 | 接死端点 | ✅ |
| 5 | 修 `delete_series_asset` 挑错集 | `pipeline.py:1216` | Bug | ✅ 按资产真实归属找持有它的那一集 |
| 6 | 项目内删全局资产（走库删除 + 409 引用方清单 + force 二次确认） | `pipeline.py:1243`、`api.ts:1560` | Bug + 决策 4.5 | ✅ 选 (a) |
| 7 | 修空图（读 `reference_sheet`） | `lib/characterImage.ts`、两处调用方 | Bug | ✅ 取图统一到 `characterImageUrl` / `scenePropImageUrl` |
| 8 | `[object Object]`：统一 `errorMessage(err)` | `lib/utils.ts` + 调用点 | Bug | ✅ 助手已加，资产链路已改；其余调用点可逐步接 |
| 9 | 「提升」改成移动 + 沿用原 id（不再产生重复卡） | `pipeline.promote_asset_to_library` | 行为修正 | ✅ 源池那条被摘掉，拒绝重复提升 |

**新增的合并原语**（只有一份实现）：
`pipeline.link_local_asset(script_id, asset_type, local_id, target_id)`
= 改写本集帧引用 → 删掉本集那条；目标在同系列别的集时先把那条提升为系列共享
（沿用原 id，所以那一集的引用不用改）。`reconcile_apply` 的 merge 也走它。

**接口变化**（均无外部调用方）：
- 新增 `GET /projects/{id}/asset-candidates?asset_type=` 与 `POST /projects/{id}/assets/link`。
- `reconcile/suggestions` 返回 `has_series` + `suggested_target_{id,name,kind,episode_title}`
  （旧的 `suggested_series_*` 已去掉）。
- `ReconcileAction.action` 的 `merge_into_series` 改叫 `merge`（后端仍兼容旧名），
  `target_series_id` → `target_id`（同样兼容旧字段）。
- `POST /assets/fork_from_library` 现在也接受**系列池**的资产（不只是全局库）。

护栏：`test_shared_asset_channels.py`（候选三层顺序/`needs_promote`、关联合并+帧改写、
跨集提升、fork 共享资产、提升移动语义、删除认归属）、
`frontend/src/__tests__/asset-image.test.ts`（取图 5 条 + errorMessage 4 条）。

**存量重复不受影响**：以前提升过的资产已经在两个池子里各一份，本轮不会自动合并。
`73号` 就是这种情况 —— 现在用「与系列对齐」或直接删多余那份都能收尾。

### P1 · 从源头少产生重复（2026-09-17 已完成）

| # | 内容 | 实现 | 状态 |
|---|---|---|---|
| 10 | 匹配池扩到四层 | `list_asset_candidates`（系列 → 全局 → 本集 → 同系列其它集） | ✅ |
| 11 | 提取时**同名直接复用**共享资产 | `pipeline._reuse_shared_entities`，`reparse_project(reuse_existing=True)` | ✅ |
| 12 | 提取时注入已有名册 | `llm.parse_novel(known_entities=…)` + `pipeline._known_entity_roster` | ✅ |

**11 为什么不做成"新实体一律入系列池"**（原计划）：那样会把一次性配角（「围观百姓」
「路人乙」「73号」）也灌进系列池，反过来污染每一集的候选清单和提取名册。
真正该自动化的只有一件事：**名字已经存在 → 不要再存一份**。所以规则是

- 解析出的实体名命中了**系列池 / 全局库** → 本集不存副本，直接引用共享那条；
  只把新提取到的描述写进它的 `extracted_description`，**不动 `description`**
  （后者是生图依据，改它会把已经生成好的图标记成过期）。
- 没命中 → 按老行为留在本集（群演/路人就该是本集的）。
- 本集要单独改共享那条（例如这一集刘备穿铠甲）→ 用「在本集独立一份」（fork）。

**开关在提取确认弹窗里**（默认勾选）：`EntityConfirmModal` 会对命中的实体打
`已有` 角标并显示条数，用户意识到"这其实是同一个人"时可以直接取消勾选，
回到旧的"每集各存一份、之后手动关联"行为。`ReparseProjectRequest.reuse_existing`
默认 `True`，老调用方不传等于开。

**12 的收益**：名册让模型**沿用已有名字**（`刘备` 而不是新起一个 `刘玄德`），
比事后按名字匹配便宜且可靠。名册来自三层合并读取，每类最多 30 个、描述截 40 字；
空名册时提示词逐字不变（护栏：`test_entity_roster.py`）。

### P2 · 别名（2026-09-17 已完成）

| # | 内容 | 实现 | 状态 |
|---|---|---|---|
| 13 | 资产别名：关联一次永久生效 | `{Character,Scene,Prop}.aliases` + 全链路匹配 + 详情页可编辑 | ✅ |

- **自动记录**：`link_local_asset` 把被合并掉的那个名字写进目标的别名
  （`刘玄德 → 刘备.aliases`）。
- **全链路认别名**（都走 `pipeline._asset_name_keys`）：
  提取同名复用（`_reuse_shared_entities`）、对齐建议（`_name_match_confidence`）、
  分镜实体回填（`analyze_text_to_frames` 的场景/角色/道具），
  另外 `entities_json` 也把 `aliases` 带给分镜模型。
- **可看见、可删除**：资产详情（`CharacterWorkbench` 描述面板）里是一排别名 chip，
  点 × 删除、回车添加 → `POST /projects/{id}/assets/aliases`（空数组 = 清空），
  后端按 `_find_asset_with_source` 写到真正持有它的那一层。
  没有这个出口的话，写错的别名会一直自动命中，等于埋雷。
- 护栏：`test_shared_asset_channels.py`（`_asset_name_keys`、关联记别名 + 下一集自动复用 +
  不叠重复别名、`set_asset_aliases` 的分层路由与去重）。

### P2 · legacy → unified 工作流迁移（**结论变了，先不做**）

查证结果：`workflow_mode` **后端只存不用**（`grep workflow_mode src/` 只有赋值和模型定义），
所有差异都在前端 `stepsForWorkflow` → `LEGACY_STEPS` / `UNIFIED_STEPS`；
而 `StoryboardR2V` 读的是**同一份 `script.frames`**（`frameToShotNode`，`StoryboardR2V.tsx:55/505`），
Cast 读的也是合并后的 `currentProject.characters`。

**所以迁移不是数据迁移，只是翻一个标志位**——v3 文档里那句"数据迁移复杂"说的是
`content_mode`（scripted/freeform），不是 `workflow_mode`。实现大概 20 行：
`POST /series/{id}/migrate_workflow` 把系列和它的每一集 `workflow_mode` 一起翻成 `r2v`，
可逆（翻回 `i2v_legacy` 即可）。

**为什么还是先不做**：这一步无法在当前环境验证。切过去之后 5.分镜 从
`StoryboardComposer`（frames 列表）变成 `StoryboardR2V`（shot workbench），
你的三国已经有 20 镜 + 生成过的图，**我没法确认新 UI 打开老数据一切正常**，
而在没验证的情况下给一个"一键切换整个项目 UI"的按钮是不负责任的。
先修好前端 / 发一版，在真机上用一份项目副本试一次，再补这个按钮。

（另：四个老系列之所以是 legacy，是因为它们早于前端默认值改成 `r2v` 那次改动。
新建的项目已经是 unified。）

---

## 6. 验收标准

1. 新建第 N 集 → 提取实体 → **不生成任何图**，先在资产库里「关联已有资产」绑到
   第 1 集的刘备 → 分镜生成的 `character_ref_names` 用的是第 1 集那条 id。
2. 资产卡片上能一眼看出该条属于「本集 / 系列 / 全局」，且改动归属后角标实时更新。
3. 三个删除路径全部可删且提示正确：
   集内 → 直接删；系列 → 删系列池 + 全系列帧引用清空；全局 → 409 列出引用方，
   二次确认后 force 删。
4. 提升一条集内资产到系列，**项目里卡片数不变**（提升后仍是 1 张）。
5. 错误提示里不再出现 `[object Object]`。
6. 两条测试护栏：
   - `_delete_asset` 对三种 source 的路由（含"资产属于别的集"）
   - 合并去重后同名不同 id 仍为两条（锁住"不按名字合并"这个决定）

---

## 7. 迁移与风险

- **零迁移**：P0/P1 只动读取展示、匹配池和写入默认值，不改 `projects.json` /
  `series.json` / `library_assets.json` 的字段。
- **存量重复**：已经把资产提升过全局库的项目，现在会看到两份（如 `73号`）。
  需要一次性清理脚本（比对同名 + 有图，提示用户保留哪一份）。**手动确认，不自动删。**
- **风险：全局库资产被项目改动会反写到全局**（D1 活引用）。UI 必须标注，
  跨层编辑要有"这会影响所有项目"的确认，或者直接引导用户先 `fork`。
- **风险：legacy 系列吃不到新功能**。三国、功夫女优、好看的、测试全是 `i2v_legacy`，
  Cast / reconcile 那一套默认不可见 → P0 的方案必须在 ConsistencyVault 里也能用。

## 8. 开放问题

1. 4.5 的项目内删除语义选 (a) 从全局库真删，还是 (b) 仅本项目隐藏？（倾向 a）
2. 「提升到系列」与「提升到全局」要不要合成一个"改归属"下拉，减少两个按钮的认知成本？
3. 系列池与全局库重叠（同一个角色两处都有）时，是否需要"以系列为准"的显式优先级提示？
4. P2 的别名要不要一开始就上 `aliases` 字段（趁现在数据量小），还是等 P1 观察误匹配率？
