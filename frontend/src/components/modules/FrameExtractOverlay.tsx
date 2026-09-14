"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { ChevronLeft, ChevronRight, Loader2, Scissors, X } from "lucide-react";
import { getAssetUrl } from "@/lib/utils";

/**
 * 截帧浮层：从一段已生成的视频里取任意一帧当参考图。
 *
 * 为什么要浮层而不是卡片上一键截图：做「下一段的位置关系参考」时，你要的是
 * **某一个确定的瞬间**（通常是人物站位最清楚的那一帧），而卡片预览的暂停位置
 * 是随机的。所以这里给时间轴 + 时间码 + ±0.1s 微调。
 *
 * 为什么用 canvas 而不是 ffmpeg：视频是由本地后端 `/files/...` 同源提供的（响应
 * 带 `access-control-allow-origin`），`<video crossOrigin="anonymous">` 画进
 * canvas 不会被判污染，`toBlob()` 能出图。零依赖、瞬时，而且不依赖打包进 app 的
 * ffmpeg（本机 `bin/ffmpeg` 是坏的，缺 dylib，所以那条路在别人机器上大概率也废）。
 */

interface FrameExtractOverlayProps {
    /** 视频的相对路径，交给 getAssetUrl 拼成同源 URL */
    videoPath: string;
    /** 来源标识，例如 "#1ea853"，会拼进帧的名字里 */
    label: string;
    onClose: () => void;
    onExtract: (file: File, name: string) => void;
}

/** ±微调的步长。0.1s 比"一帧"好按 —— 25fps 一帧才 0.04s。 */
const STEP_SECONDS = 0.1;
/** 等 seeked 的兜底时限：目标时刻与当前相同的话不会再触发 seeked。 */
const SEEK_TIMEOUT_MS = 3000;

function formatTimecode(seconds: number): string {
    if (!Number.isFinite(seconds) || seconds < 0) return "00:00.0";
    const minutes = Math.floor(seconds / 60);
    const rest = seconds - minutes * 60;
    return `${String(minutes).padStart(2, "0")}:${rest.toFixed(1).padStart(4, "0")}`;
}

function toFilename(label: string, seconds: number): string {
    const clean = label.replace(/[^0-9a-zA-Z]/g, "");
    const stamp = formatTimecode(seconds).replace(/[:.]/g, "-");
    return `frame_${clean}_${stamp}.png`;
}

export default function FrameExtractOverlay({
    videoPath,
    label,
    onClose,
    onExtract,
}: FrameExtractOverlayProps) {
    const t = useTranslations("creator");
    const videoRef = useRef<HTMLVideoElement>(null);
    const [duration, setDuration] = useState(0);
    const [time, setTime] = useState(0);
    const [ready, setReady] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    // crossOrigin 必须先落在元素上、再设 src，否则视频已经按非 CORS 模式加载完，
    // canvas 会被判成污染，toBlob() 抛 SecurityError。JSX 属性顺序不保证，所以
    // 手动按顺序设。
    //
    // URL 上带一个一次性查询参数：后端已经补了 `Vary: Origin`（见 api.py 的
    // add_cache_control_header），但那只能保护**新**请求。同一个 URL 如果早先被
    // 卡片里那个不带 crossOrigin 的 <video> 缓存过（`max-age=86400`），那份没有
    // Access-Control-Allow-Origin 的响应还是会被复用，截帧直接失败 —— 而 WebView
    // 的磁盘缓存我们清不掉。带个一次性参数就永远命中不到陈旧缓存。
    // 视频来自本机后端（127.0.0.1），重下一次的代价可以忽略。
    useEffect(() => {
        const video = videoRef.current;
        if (!video) return;
        setReady(false);
        setError(null);
        setTime(0);
        setDuration(0);
        video.crossOrigin = "anonymous";
        video.src = `${getAssetUrl(videoPath)}?extract=${Date.now()}`;
        video.load();
    }, [videoPath]);

    const seek = useCallback((next: number) => {
        const video = videoRef.current;
        if (!video || !Number.isFinite(video.duration) || video.duration <= 0) return;
        const clamped = Math.min(Math.max(next, 0), video.duration);
        video.currentTime = clamped;
        setTime(clamped);
    }, []);

    /** 等视频真的停在 target 那一帧，再交给 canvas 画。 */
    const waitForSeek = useCallback((video: HTMLVideoElement, target: number) => {
        if (Math.abs(video.currentTime - target) < 1e-3 && video.readyState >= 2) {
            return Promise.resolve();
        }
        return new Promise<void>((resolve, reject) => {
            let settled = false;
            const finish = (err?: Error) => {
                if (settled) return;
                settled = true;
                video.removeEventListener("seeked", onSeeked);
                video.removeEventListener("error", onError);
                window.clearTimeout(timer);
                err ? reject(err) : resolve();
            };
            const onSeeked = () => finish();
            const onError = () => finish(new Error(t("frameExtractFailed")));
            const timer = window.setTimeout(() => finish(), SEEK_TIMEOUT_MS);
            video.addEventListener("seeked", onSeeked);
            video.addEventListener("error", onError);
            video.currentTime = target;
        });
    }, [t]);

    const handleExtract = async () => {
        const video = videoRef.current;
        if (!video) return;
        setBusy(true);
        setError(null);
        try {
            if (!video.videoWidth || !video.videoHeight) {
                throw new Error(t("frameExtractNoVideo"));
            }
            await waitForSeek(video, time);

            // 用原生分辨率，不缩放 —— 位置关系参考吃分辨率。
            const canvas = document.createElement("canvas");
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
            const ctx = canvas.getContext("2d");
            if (!ctx) throw new Error(t("frameExtractFailed"));
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

            const blob = await new Promise<Blob | null>((resolve) =>
                canvas.toBlob(resolve, "image/png")
            );
            if (!blob) throw new Error(t("frameExtractTainted"));

            const name = `${label} @ ${formatTimecode(time)}`;
            onExtract(
                new File([blob], toFilename(label, time), { type: "image/png" }),
                name
            );
            onClose();
        } catch (e) {
            setError(e instanceof Error ? e.message : t("frameExtractFailed"));
        } finally {
            setBusy(false);
        }
    };

    return (
        <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6"
            onClick={onClose}
        >
            <div
                className="flex w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-glass-border bg-surface shadow-2xl"
                onClick={(e) => e.stopPropagation()}
            >
                <div className="flex items-center justify-between border-b border-glass-border px-4 py-3">
                    <div className="flex items-center gap-2">
                        <Scissors size={15} className="text-primary" />
                        <span className="text-sm font-medium text-foreground">
                            {t("frameExtractTitle")}
                        </span>
                        <span className="font-mono text-xs text-text-muted">{label}</span>
                    </div>
                    <button
                        type="button"
                        onClick={onClose}
                        className="rounded p-1 text-text-muted hover:bg-hover-bg hover:text-foreground"
                    >
                        <X size={16} />
                    </button>
                </div>

                <div className="bg-black">
                    <video
                        ref={videoRef}
                        className="max-h-[52vh] w-full object-contain"
                        muted
                        playsInline
                        preload="auto"
                        onLoadedMetadata={(e) => {
                            setDuration(e.currentTarget.duration || 0);
                            setReady(true);
                        }}
                        onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
                        onError={() => setError(t("frameExtractNoVideo"))}
                    />
                </div>

                <div className="space-y-3 px-4 py-4">
                    <div className="flex items-center gap-3">
                        <input
                            type="range"
                            min={0}
                            max={duration || 0}
                            step={0.01}
                            value={time}
                            disabled={!ready}
                            onChange={(e) => seek(Number(e.target.value))}
                            className="h-1 flex-1 cursor-pointer accent-primary disabled:opacity-40"
                        />
                        <span className="shrink-0 font-mono text-xs text-text-secondary tabular-nums">
                            {formatTimecode(time)} / {formatTimecode(duration)}
                        </span>
                    </div>

                    <div className="flex flex-wrap items-center justify-between gap-3">
                        <div className="flex items-center gap-2">
                            <button
                                type="button"
                                disabled={!ready}
                                onClick={() => seek(time - STEP_SECONDS)}
                                className="flex items-center gap-1 rounded-md border border-glass-border px-2 py-1 text-xs text-text-secondary hover:bg-hover-bg disabled:opacity-40"
                            >
                                <ChevronLeft size={13} />
                                {STEP_SECONDS.toFixed(1)}s
                            </button>
                            <button
                                type="button"
                                disabled={!ready}
                                onClick={() => seek(time + STEP_SECONDS)}
                                className="flex items-center gap-1 rounded-md border border-glass-border px-2 py-1 text-xs text-text-secondary hover:bg-hover-bg disabled:opacity-40"
                            >
                                {STEP_SECONDS.toFixed(1)}s
                                <ChevronRight size={13} />
                            </button>
                        </div>

                        <button
                            type="button"
                            disabled={!ready || busy}
                            onClick={() => void handleExtract()}
                            className="flex items-center gap-2 rounded-md bg-primary px-4 py-1.5 text-xs font-medium text-white disabled:opacity-50"
                        >
                            {busy ? <Loader2 size={13} className="animate-spin" /> : <Scissors size={13} />}
                            {busy ? t("frameExtractWorking") : t("frameExtractApply")}
                        </button>
                    </div>

                    <p className="text-[0.6875rem] text-text-muted">{t("frameExtractHint")}</p>
                    {error && <p className="text-xs text-red-400">{error}</p>}
                </div>
            </div>
        </div>
    );
}
