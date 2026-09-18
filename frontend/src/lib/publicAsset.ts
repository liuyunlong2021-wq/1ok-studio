/**
 * public/ 下资源的 URL 前缀。
 *
 * Next 只给 `next/image`、静态 import 和它自己产出的资源自动加 basePath；
 * **手写的 `src="/foo.png"` 不会加**。而桌面 APP（`main.py`）加载的是默认生产
 * 构建，那份构建的 basePath 是 `/static`（见 next.config.mjs），于是这些 URL
 * 全部 404 —— 在 WebView2 里就是一张破图，也就是 Windows 端 logo 一直"不对劲"
 * 的根因（同样中招的还有 favicon 和 CastWorkbench 的模板示例图）。
 *
 * 凡是引用 public/ 下的文件，路径都过一遍 publicAsset()。
 */

const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

/**
 * @param path 以 `/` 开头的 public/ 资源路径，例如 `/1ok-logo-preview.svg`
 * @param basePath 仅供测试覆盖；生产用法不传，走构建期注入的 NEXT_PUBLIC_BASE_PATH
 */
export function publicAsset(path: string, basePath: string = BASE_PATH): string {
    if (!path.startsWith("/")) return path;
    return `${basePath}${path}`;
}
