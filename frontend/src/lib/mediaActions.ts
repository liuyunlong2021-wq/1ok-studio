/**
 * 本机媒体操作：保存一份副本到用户选的位置 / 在文件管理器里选中该文件。
 *
 * 为什么不能再用 DOM 的 `<a download>`：Tauri 的 WKWebView **不实现 download
 * 属性**（需要 WKDownloadDelegate，Tauri 没有设），所以 `a.click()` 是**静默无效**
 * 的 —— 不报错、不弹窗、什么都不发生。浏览器里能用、打包版里不能，这就是
 * 「点了下载没反应」的由来。
 *
 * 生成的媒体本来就已经落在本地数据目录里，所以这里走「原生保存对话框 + 本地
 * 拷贝」，不经过网络。开发态（`npm run dev` 跑在浏览器里）没有原生对话框，回退到
 * blob 下载，保证开发时功能不消失。
 */

/** 打包版（Tauri webview）里才有 __TAURI_INTERNALS__。 */
function inTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/**
 * 保存一份副本到用户选择的位置。
 *
 * @returns 落盘路径；用户取消时返回 null；浏览器回退路径返回下载文件名。
 */
export async function saveMedia(
  mediaPath: string,
  mediaUrl: string | null,
): Promise<string | null> {
  if (inTauri()) {
    const { invoke } = await import("@tauri-apps/api/core");
    // Tauri 把 Rust 侧的 `media_path` 按 camelCase 暴露成 `mediaPath`。
    return invoke<string | null>("save_media", { mediaPath });
  }

  // 浏览器回退：原生保存对话框不存在，退回 blob 下载。
  if (!mediaUrl) return null;
  const response = await fetch(mediaUrl);
  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  anchor.download = mediaPath.split("/").pop() || "download";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(objectUrl);
  return anchor.download;
}

/**
 * 在 Finder（macOS）/ 资源管理器里选中该文件。
 *
 * 生成物本来就在本地，大多数时候用户要的是「它在哪」，而不是「再拷一份」。
 */
export async function revealMedia(mediaPath: string): Promise<boolean> {
  if (!inTauri()) return false;
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("reveal_media", { mediaPath });
  return true;
}
