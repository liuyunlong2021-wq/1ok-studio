/**
 * Report a client-side error to the backend so it lands in a log file.
 *
 * The packaged desktop app has no devtools and no visible console, so an
 * uncaught render error would otherwise leave no trace anywhere: the user sees
 * a sentence telling them to open a console they do not have, and whoever
 * supports them has nothing to go on.
 *
 * Best effort by design — it runs while the app is already broken, so every
 * failure path is swallowed. The on-screen rendering in global-error.tsx is the
 * primary channel; this is the copy that survives.
 */
export async function reportClientError(payload: {
    message: string;
    stack?: string;
    digest?: string;
    url?: string;
}): Promise<void> {
    // Written straight to the backend rather than through invoke(): the Tauri
    // IPC path is one of the things that may be broken, and this must not
    // depend on it. CSP already allows http://127.0.0.1:* for connect-src.
    const base = "http://127.0.0.1:17177";

    try {
        await fetch(`${base}/debug/client-error`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                ...payload,
                url: payload.url ?? (typeof window !== "undefined" ? window.location.href : ""),
                userAgent: typeof navigator !== "undefined" ? navigator.userAgent : "",
            }),
        });
    } catch {
        // Nothing useful to do — the app is already in its error state.
    }
}
