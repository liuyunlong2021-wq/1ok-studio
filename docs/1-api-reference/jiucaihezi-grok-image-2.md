# Grok Imagine Image 2.0 接入证据

核对日期：2026-09-08。模型 ID：`grok-imagine-image-2.0`。

- 官方模型说明：https://x.ai/news/grok-imagine-image-2
- 参数参考：https://developers.cloudflare.com/ai/models/xai/grok-imagine-image-2.0/
- 网关合同：`/Users/by3/Documents/jiucaihezi-app/docs/wiki/运维/小易图片模型接口与NewAPI接入-2026-09-04.md`
- 现有上游模型登记：`/Users/by3/Documents/jiucaihezi-app/src/runtime/creation/creationModelRegistry.ts`。

沿用韭菜盒子 OpenAI 兼容图片通道，文生图 `/v1/images/generations`，图生图 `/v1/images/edits`。目录前缀 `jiucaihezi/` 由现有适配器移除，发送原始模型名。保守开放 1K/2K 和最多 5 张参考图；不改变默认模型。

本次使用仓库内证据镜像，未同步 Context Hub。自动验证覆盖目录选择及请求合同，未执行付费真实生成；网关渠道可用性需真实生成验证。
