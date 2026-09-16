"use client";

import { useEffect } from "react";

import { reportClientError } from "@/lib/clientErrorReport";

/**
 * Root error boundary.
 *
 * Next.js's default for this case is "Application error: a client-side
 * exception has occurred (see the browser console for more information)" —
 * useless in the packaged desktop app, which has no browser console. Render the
 * error itself so it is actionable on screen, and report it to the backend so
 * it also reaches a log file.
 *
 * Deliberately inline styles: this boundary replaces the root layout, so it
 * cannot rely on anything the app's stylesheets or providers set up.
 */
export default function GlobalError({
    error,
    reset,
}: {
    error: Error & { digest?: string };
    reset: () => void;
}) {
    useEffect(() => {
        void reportClientError({
            message: `${error.name}: ${error.message}`,
            stack: error.stack,
            digest: error.digest,
        });
    }, [error]);

    return (
        <html lang="zh">
            <body
                style={{
                    margin: 0,
                    padding: "32px",
                    background: "#050508",
                    color: "#e8e8ef",
                    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
                    fontSize: "13px",
                    lineHeight: 1.6,
                }}
            >
                <h1 style={{ fontSize: "16px", margin: "0 0 4px" }}>界面启动失败</h1>
                <p style={{ margin: "0 0 24px", color: "#9a9aa8" }}>
                    错误已写入 C:\Users\&lt;你&gt;\.1okstudio\logs\ 下的日志文件。
                </p>

                <p style={{ margin: "0 0 4px", color: "#ffa94d" }}>
                    {error.name}: {error.message}
                </p>
                {error.digest ? (
                    <p style={{ margin: "0 0 4px", color: "#9a9aa8" }}>digest: {error.digest}</p>
                ) : null}

                {error.stack ? (
                    <pre
                        style={{
                            margin: "16px 0 24px",
                            padding: "16px",
                            background: "#101013",
                            border: "1px solid #26262e",
                            borderRadius: "6px",
                            whiteSpace: "pre-wrap",
                            wordBreak: "break-word",
                            maxHeight: "50vh",
                            overflow: "auto",
                        }}
                    >
                        {error.stack}
                    </pre>
                ) : null}

                <button
                    onClick={reset}
                    style={{
                        padding: "8px 20px",
                        background: "#34d8c4",
                        color: "#050508",
                        border: "none",
                        borderRadius: "6px",
                        fontSize: "13px",
                        cursor: "pointer",
                    }}
                >
                    重试
                </button>
            </body>
        </html>
    );
}
