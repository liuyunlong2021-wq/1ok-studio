import { API_URL } from "./api";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
    return twMerge(clsx(inputs));
}

/**
 * 从任意异常里提取一句能给人看的消息。
 *
 * FastAPI 的 `detail` 在 422 校验失败时是**数组**、在自定义错误里可能是**对象**
 * （例如全局资产被引用时的 409）。直接 `alert(detail)` 会渲染成 “[object Object]”:
 * 用户看不懂，也没了原因。
 */
export function errorMessage(error: unknown, fallback = "操作失败"): string {
    const detail = (error as { response?: { data?: { detail?: unknown } } })?.response?.data?.detail;
    if (typeof detail === "string" && detail.trim()) return detail;
    if (detail && typeof detail === "object") {
        const message = (detail as { message?: unknown }).message;
        if (typeof message === "string" && message.trim()) return message;
        return JSON.stringify(detail);
    }
    if (error instanceof Error && error.message) return error.message;
    return fallback;
}

export function getAssetUrl(path: string | null | undefined): string {
    if (!path) return "";
    if (path.startsWith("http") || path.startsWith("blob:")) {
        // Only pass through well-formed http(s)/blob URLs; anything else
        // (e.g. javascript: smuggled behind a weird prefix) is dropped.
        try {
            const protocol = new URL(path).protocol;
            if (protocol === "http:" || protocol === "https:" || protocol === "blob:") {
                // Strip HTML metacharacters as well; well-formed URLs never
                // contain them raw, so this is a no-op for legitimate values.
                return path.replace(/[<>"'`]/g, "");
            }
        } catch {
            // malformed URL — fall through to reject
        }
        return "";
    }

    // Normalize separators before stripping the prefix. Refs written by
    // os.path.join (Windows) arrive as `output\playground\images\x.png`, which
    // `/^output\//` does not match — the prefix survived and /files resolved
    // output/output/... instead. Refs are documented as relative to output/ in
    // apps/playground/models.py.
    // Remove leading slash if present to avoid double slashes with API_URL/files/
    const cleanPath = (path.startsWith("/") ? path.slice(1) : path)
        .replace(/\\/g, "/")
        .replace(/^output\//, "");
    return `${API_URL}/files/${encodeURI(cleanPath)}`;
}

export function getAssetUrlWithTimestamp(path: string | null | undefined, timestamp?: number): string {
    const baseUrl = getAssetUrl(path);
    if (!baseUrl) return "";

    // If URL already has query params, append with & otherwise with ?
    const separator = baseUrl.includes('?') ? '&' : '?';
    return baseUrl + separator + `t=${timestamp || 0}`;
}

export function extractErrorDetail(error: any, fallback = "未知错误"): string {
    return error?.response?.data?.detail
        || error?.response?.data?.message
        || error?.message
        || fallback;
}
