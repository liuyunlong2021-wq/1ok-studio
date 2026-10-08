# FK 图片模型参数合同

来源：用户截图（展示名与真实模型 ID），以及本机 `/Users/by3/Documents/jiucaihezi-app/newapi-plugins/fk.plugin.js` 的 `openai_image.decodeRequest`、`normalizeImageSize`、`ratioFromSize`。采集日期：2026-10-08。

适用范围：FK-image2、FK-image2.5、FK-image2.5-flare、FK-image2.5-sunburst、FK-banana-2、FK-banana-pro。请求 `model` 使用目录中完整 `ft-image-v1-*` ID，展示名仅用于 UI。

文生图使用 `/v1/images/generations` JSON；图生图使用 `/v1/images/edits` multipart。两种请求都传 `imageSize`（1K、2K、4K）与 `ratio`（auto、1:1、9:16、16:9、4:3、3:4、3:2、2:3、5:4、4:5、21:9）。应用默认 2K、9:16，用户可调整。

插件用 `size` 像素值推算比例，不用它设置分辨率档位；FK 请求以显式 `imageSize` 与 `ratio` 为准，不附带其他模型遗留的 `size`、`quality`。

插件未声明各模型单独的参数限制。以上是插件能解析的选项，真实生成、各档位可用性和实际输出像素未逐项验收。此为本仓库证据镜像，未同步外部文档归档或 Context Hub。
