# 韭菜盒子本机 Qwen Image 2.1 与 MiniMax H3 接入依据

- Capture date: 2026-10-02
- Provider/family: `jiucaihezi`
- Public base URL: `https://api.jiucaihezi.studio`
- Source documents (maintained in the neighboring `jiucaihezi-app` project):
  - `docs/wiki/运维/韭菜盒子本机ComfyUI图片模型API对外接入-2026-09-26.md`
  - `docs/wiki/运维/韭菜盒子本机ComfyUI视频模型API对外接入-2026-09-26.md`

## `jc-qwen-image-2.1`

- Catalog/UI ID is `jc-qwen-image-2.1`; send `model: qwen-image-2.1` to the gateway.
- `POST /v1/images/generations`; references switch the same model into image-edit mode. `/v1/images/edits` is also supported.
- `size` accepts the 14 documented 1K/2K pixel dimensions; default `1080x1920`. Width/height multiples of 8, maximum side 2048, maximum 2.1 MP.
- Up to 10 reference images. Response is inline `b64_json`; synchronous request.

## `jc-minimax-h3`

- Catalog/UI ID is `jc-minimax-h3`; send `model: minimax-h3` to the gateway.
- `POST /v1/videos`; asynchronous task polling at `GET /v1/videos/{task_id}` and download at `/content`.
- No image means text-to-video. `first_frame` enables first-frame video; optional `last_frame` adds an ending frame. Do not send `images`.
- `duration`: 1–28 seconds, default 5. `size`: documented pixel dimensions only, default `1344x768`; max side 2048 and max 2.1 MP. The API calls this field `size` (catalog/UI calls it `resolution`).
- The generated video includes synchronized audio; audio reference fields are unsupported.

## `jc-minimax-h3-ref2v`

- Catalog/UI ID is `jc-minimax-h3-ref2v`; send `model: minimax-h3-ref2v` to the gateway.
- `POST /v1/videos`; asynchronous task polling and download as above.
- `images`: 1–6 ordered reference image URLs. Do not send `first_frame`/`last_frame`.
- `duration`: 1–28 seconds, default 3. `aspect_ratio`: one of the eight documented labeled values (including the parenthetical labels), default `16:9 (Widescreen)`.
- The generated video includes synchronized audio; audio reference fields are unsupported.

Both video models share a single GPU queue with the image model. Raw archive and Context Hub promotion remain owned by the neighboring API project; this file is a repo-local evidence mirror for this implementation.
