# 网页版（1ok.jiucaihezi.studio）筹备

> 状态：**未开工**。本文只记录已核实的事实、要改的地方和坑，供以后接着做。
> 采集日期：2026-10-07 · 现场：本机 macOS + 真实 Key 打通 NewAPI。

## 1. 目标形态

```
用户浏览器 ──直连──> https://api.jiucaihezi.studio   （NewAPI，我们自己的后端）
     │                    提交任务 / 轮询 / 下载成片
     └── 静态网页 https://1ok.jiucaihezi.studio     （只放静态文件，无自有服务）
```

- **无账号、无计费、无自有后端**：每个用户在页面上填**自己的**韭菜盒子 API Key（存浏览器），
  费用由各自的 Key 承担。
- 网页版第一版 = **创作台**：填提示词 → 选模型/时长/画幅 → 出片 → 下载。
- 部署方式参照用户另一个项目：静态产物挂到子域名即可，"挂上去就行"。

## 2. 已实测的跨域（CORS）现状

用**真实 Key** 打 `https://api.jiucaihezi.studio`（2026-10-07 实测，带 `Origin` 头）：

| 接口 | 用途 | 真实响应带 `Access-Control-Allow-Origin` | 浏览器能否直连 |
| --- | --- | --- | --- |
| `POST /v1/videos` | 提交视频任务 | ✅ `*` | ✅ |
| `GET /v1/videos/{id}` | 轮询状态 | ✅ `*` | ✅ |
| `GET /v1/videos/{id}/content` | 下载成片 | ✅ `*` | ✅ |
| `POST /v1/images/generations`（OPTIONS 预检） | 出图 | ✅ `*` | ✅ |
| `GET /v1/models` | 模型清单 | ❌ 无 | ❌ |
| `POST /v1/audio/speech`（预检） | 配音 | ❌ 无 | ❌ |
| `POST /api/creations/uploads`（预检） | 本机图片转公网 URL | ❌ 无 | ❌ |

预检细节：`OPTIONS /v1/videos` → `204`，`allow-origin: *`、`allow-methods: GET,POST,PUT,DELETE,OPTIONS`、
`allow-headers: *` —— 即视频主链路已经为浏览器放开。

**结论：视频主链路（提交 / 轮询 / 下载）现在就能直连，不需要代理服务。**

### 复现脚本（把 Key 从 `~/.1okstudio/config.json` 读，不回显）

```python
import json, pathlib, requests
key = json.loads((pathlib.Path.home()/".1okstudio"/"config.json").read_text())["JIUCAIHEZI_API_KEY"]
U = {"User-Agent": "Mozilla/5.0 check", "Origin": "https://example.com"}
base = "https://api.jiucaihezi.studio"
r = requests.get(f"{base}/v1/models", headers={**U, "Authorization": f"Bearer {key}"}, timeout=20)
print(r.status_code, r.headers.get("access-control-allow-origin"))   # 200 None → 缺头
r = requests.options(f"{base}/v1/videos", headers={**U, "Access-Control-Request-Method": "POST",
    "Access-Control-Request-Headers": "authorization,content-type"}, timeout=20)
print(r.status_code, r.headers.get("access-control-allow-origin"))   # 204 *
```

## 3. 要改的地方（代码盘点）

现在创作台的长链路是「浏览器 → 自有后端 → NewAPI」，后端还兼了参数拼装、任务落盘、素材存储。
网页版要去掉中间那层：

| 位置 | 现在 | 网页版要做 |
| --- | --- | --- |
| `frontend/src/lib/api.ts` | `API_URL` 指向自有后端（`playgroundApi.*`） | 加**直连模式**：提交/轮询/下载打 `https://api.jiucaihezi.studio` |
| `frontend/src/components/modules/playground/usePlaygroundStore.ts` | 走 `playgroundApi` 提交 + 轮询 | 换直连实现；历史改存 IndexedDB/localStorage |
| Key 来源 | 后端 `~/.1okstudio/config.json` | 浏览器 localStorage（可复用设置页的 Key 输入 UI） |
| 模型清单 | `frontend/src/generated/modelCatalog.json`（**已经是内置目录**） | 不改 ✅（所以 `GET /v1/models` 缺 CORS 不影响） |
| 成片播放 | 后端 `/files/...` 直链 | `fetch` 带 `Authorization` → `blob:` → `<video>`；下载用 `URL.createObjectURL` |
| 截帧 | 前端 canvas（已实现） | 不改 ✅ |

构建方式：网页版需要**无 basePath 的静态产物**＝ `frontend/out`，用
`DOCKER_BUILD=true npm run build`（见 `frontend/next.config.mjs`：默认 prod 会带 `/static` 前缀，
那是给自有后端托管用的，网页版不要）。

### 参数拼装的唯一事实源在 Python（**本方案最大的长期成本**）

现在「按模型拼请求体」的规则写在 Python：

- `src/models/fk_video.py` —— `fk_video_payload()` / `fk_video_spec()` / `split_fk_media()`（Fk 用 `imageUrls`/`videoUrls`/`audioUrls`）
- `src/utils/model_catalog.py` —— `is_minimax_h3_model()`、`resolve_local_h3_video_parameters()`、各模型时长/画幅/上限
- `docs/1-api-reference/jiucaihezi-fk-video-2026-10-06.md` —— **对外合同表**（模型 ID、分辨率、时长、画幅、参考素材上限、价格）

直连版必须在前端 **TS 里再写一份**。⚠️ 之后协议/目录一改，**两处都要改**，
否则网页版和桌面版会按不同规则拼参数。若以后不想维护两份，退路是做一个
「薄服务」（复用 Python 逻辑、Key 由请求头带、不落盘），但那就需要一台能跑容器的机器。

## 4. 部署

1. 构建：`DOCKER_BUILD=true npm run build` → 产物在 `frontend/out/`。
2. 静态目录丢到 `1ok.jiucaihezi.studio` 对应目录（参照用户另一个项目的挂法），
   nginx 里加 SPA 回退：
   ```nginx
   server {
     listen 443 ssl http2;
     server_name 1ok.jiucaihezi.studio;
     root /var/www/1ok;            # frontend/out 的内容
     index index.html;
     location / { try_files $uri $uri.html $uri/ /index.html; }
   }
   ```
3. **NewAPI 侧补三处响应头**（只在缺的接口上补，别全局补）：
   - 缺的：`/v1/models`、`/v1/audio/speech`、`/api/creations/uploads`
   - 每个 location 里加：
     ```nginx
     add_header Access-Control-Allow-Origin  "*" always;
     add_header Access-Control-Allow-Headers "authorization,content-type,x-file-name" always;
     add_header Access-Control-Allow-Methods "GET,POST,PUT,DELETE,OPTIONS" always;
     if ($request_method = OPTIONS) { return 204; }
     ```
   - ⚠️ **别在 server 级全局加**：视频那几个接口的**上游自己已经返回了 `*`**，
     再叠一层会变成**两个 `Access-Control-Allow-Origin` 值**，浏览器按规范直接判跨域失败。
     要么只加在缺的三个 location，要么先把上游那个头去掉再统一加。

## 5. 已知约束（浏览器限制，与服务器无关）

- **成片必须带 `Authorization` 下载**（合同：只能用 `/v1/videos/{id}/content`，不要用轮询里的 `url`），
  所以不能把地址直接给 `<video src>` 边下边播；只能 `fetch → blob`。单条 **12–44 MB**，
  能用但吃内存、不能续传、大文件失败要重头拉。
- 没有服务端 ffmpeg：抽帧靠前端 canvas（已有 ✓），**转码/合成/导出做不了**。
- 桌面版那些依赖本机文件系统与后端的模块**在网页版没有**：项目、剧本编辑器、资产库、
  声音（含 seed-audio 配音）、Skill 包、任务持久化。
- 「保存到本机」「在 Finder 里显示」→ 浏览器普通下载。

## 6. 下次继续前要确认的事

1. `api.jiucaihezi.studio` **前置的反代是什么**（原生 nginx / 宝塔 / 1Panel / Cloudflare），
   才能给出准确的头配置与 reload 方式。
2. 参考图上传要不要纳入第一版（依赖 `/api/creations/uploads` 的 CORS）；不要就只做纯提示词。
3. 配音要不要（`/v1/audio/speech` 补头即可，但前面没有音频编辑链路）。
4. 历史/结果存哪：IndexedDB（浏览器里能翻）还是「出片即下载」（最省）。

## 7. 验收清单（以后再跑）

- [ ] 本地：把网关地址指到真站，跑通 **提交 → 轮询 → 下载**，控制台**无 CORS 报错**
- [ ] 单条 5 秒视频：能播（blob）、能下载、文件名/后缀正确
- [ ] 真机：`https://1ok.jiucaihezi.studio` 打开 → 填 Key → 出片 → 下载
- [ ] Key 只存在浏览器（localStorage），页面/网络请求里不出现在 URL 上
- [ ] 轮询失败/超时按合同处理：**绝不重新 POST 创建任务**（会重复计费）

## 8. 顺带（不属于本文，但别忘）

桌面版还欠一次打包，排队中的三个修复：创作台不再列出账号未开通的 `Fk MiniMax H3`（撞 503）、
时长输入框可删空、参数区控件统一同高。三处都已提交到 `main`。
