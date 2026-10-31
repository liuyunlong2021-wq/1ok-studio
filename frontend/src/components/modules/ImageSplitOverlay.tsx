"use client";

import { useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { Grid2x2, Loader2, X } from "lucide-react";
import { getAssetUrl } from "@/lib/utils";
import {
    IMAGE_SPLIT_GRIDS, cropImageTiles, imageSplitLabel, imageSplitRects, type ImageSplitGrid,
} from "@/lib/imageGridSplit";

/**
 * 切图浮层：把一张「多宫格拼成一张」的成图（如 MJ 四宫格）按格子拆开。
 * 点格子选中/取消，确认后把选中的格子裁成独立 PNG 交给宿主。
 *
 * 字节取法与 FrameExtractOverlay 同理：图来自本机后端 `/files/...`（带 CORS 头），
 * 先 fetch 成 Blob 再画，canvas 不会被污染；URL 加一次性参数避开不带 CORS 头的旧缓存。
 */
interface ImageSplitOverlayProps {
    /** 图片的相对路径，交给 getAssetUrl 拼成同源 URL */
    imagePath: string;
    /** 切出来的文件名前缀 */
    label: string;
    onClose: () => void;
    onSplit: (files: File[]) => void | Promise<void>;
}

export default function ImageSplitOverlay({ imagePath, label, onClose, onSplit }: ImageSplitOverlayProps) {
    const t = useTranslations("playground");
    const [blob, setBlob] = useState<Blob | null>(null);
    const [objectUrl, setObjectUrl] = useState("");
    const [size, setSize] = useState({ width: 0, height: 0 });
    const [grid, setGrid] = useState<ImageSplitGrid>(IMAGE_SPLIT_GRIDS[0]);
    const [selected, setSelected] = useState<Set<number>>(new Set());
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    const rects = useMemo(() => imageSplitRects(size.width, size.height, grid), [size, grid]);

    useEffect(() => {
        let cancelled = false;
        let url = "";
        (async () => {
            try {
                const response = await fetch(`${getAssetUrl(imagePath)}?split=${Date.now()}`);
                if (!response.ok) throw new Error(String(response.status));
                const data = await response.blob();
                const bitmap = await createImageBitmap(data);
                const next = { width: bitmap.width, height: bitmap.height };
                bitmap.close?.();
                if (cancelled) return;
                url = URL.createObjectURL(data);
                setBlob(data);
                setObjectUrl(url);
                setSize(next);
            } catch {
                if (!cancelled) setError(t("split.loadFailed"));
            }
        })();
        return () => {
            cancelled = true;
            if (url) URL.revokeObjectURL(url);
        };
    }, [imagePath, t]);

    // 换网格或图片加载完成后默认全选
    useEffect(() => {
        setSelected(new Set(imageSplitRects(size.width, size.height, grid).map((rect) => rect.index)));
    }, [size, grid]);

    useEffect(() => {
        const handler = (event: KeyboardEvent) => {
            if (event.key === "Escape") onClose();
        };
        document.addEventListener("keydown", handler, true);
        return () => document.removeEventListener("keydown", handler, true);
    }, [onClose]);

    const toggle = (index: number) => {
        setSelected((prev) => {
            const next = new Set(prev);
            if (next.has(index)) next.delete(index);
            else next.add(index);
            return next;
        });
    };

    const confirm = async () => {
        if (!blob || selected.size === 0) return;
        setBusy(true);
        setError(null);
        try {
            const files = await cropImageTiles(blob, grid, Array.from(selected).sort((a, b) => a - b), label);
            await onSplit(files);
            onClose();
        } catch {
            setError(t("split.failed"));
        } finally {
            setBusy(false);
        }
    };

    return (
        <div
            className="fixed inset-0 z-[70] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4"
            onClick={onClose}
        >
            <section
                role="dialog"
                aria-modal="true"
                aria-label={t("split.title")}
                onClick={(e) => e.stopPropagation()}
                className="flex max-h-[92vh] w-[min(920px,94vw)] flex-col overflow-hidden rounded-2xl border border-glass-border bg-surface shadow-2xl"
            >
                <header className="flex items-center gap-2 border-b border-glass-border px-4 py-3">
                    <Grid2x2 className="h-4 w-4 text-text-secondary" />
                    <strong className="text-sm text-foreground">{t("split.title")}</strong>
                    <button
                        type="button"
                        onClick={onClose}
                        aria-label={t("split.cancel")}
                        className="ml-auto grid h-7 w-7 place-items-center rounded-md text-text-muted hover:bg-hover-bg hover:text-foreground"
                    >
                        <X className="h-4 w-4" />
                    </button>
                </header>

                <div className="flex items-center gap-2 border-b border-glass-border px-4 py-2.5">
                    {IMAGE_SPLIT_GRIDS.map((option) => {
                        const active = option.rows === grid.rows && option.cols === grid.cols;
                        return (
                            <button
                                key={imageSplitLabel(option)}
                                type="button"
                                onClick={() => setGrid(option)}
                                className={`rounded-lg border px-2.5 py-1 font-mono text-xs transition ${
                                    active
                                        ? "border-primary text-primary bg-primary/10"
                                        : "border-glass-border text-text-secondary hover:bg-hover-bg"
                                }`}
                            >
                                {imageSplitLabel(option)}
                            </button>
                        );
                    })}
                    <button
                        type="button"
                        disabled={selected.size === rects.length}
                        onClick={() => setSelected(new Set(rects.map((rect) => rect.index)))}
                        className="rounded-lg border border-glass-border px-2.5 py-1 text-xs text-text-secondary hover:bg-hover-bg disabled:opacity-50"
                    >
                        {t("split.selectAll")}
                    </button>
                    <span className="ml-auto font-mono text-xs text-text-muted">
                        {selected.size} / {rects.length}
                    </span>
                </div>

                <div className="flex min-h-[240px] flex-1 items-center justify-center overflow-auto bg-surface-inset p-3">
                    {objectUrl && size.width ? (
                        <div className="relative max-h-[58vh] max-w-full">
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img src={objectUrl} alt="" className="block max-h-[58vh] max-w-full" />
                            {rects.map((rect) => {
                                const on = selected.has(rect.index);
                                return (
                                    <button
                                        key={rect.index}
                                        type="button"
                                        onClick={() => toggle(rect.index)}
                                        title={`#${rect.index} · ${rect.width}×${rect.height}`}
                                        style={{
                                            left: `${(rect.x / size.width) * 100}%`,
                                            top: `${(rect.y / size.height) * 100}%`,
                                            width: `${(rect.width / size.width) * 100}%`,
                                            height: `${(rect.height / size.height) * 100}%`,
                                        }}
                                        className={`absolute grid place-items-center border-2 transition ${
                                            on ? "border-primary bg-primary/20" : "border-transparent bg-white/5 hover:bg-white/15"
                                        }`}
                                    >
                                        <span
                                            className={`grid h-6 w-6 place-items-center rounded-full text-xs text-white ${
                                                on ? "bg-primary" : "bg-black/55"
                                            }`}
                                        >
                                            {rect.index}
                                        </span>
                                    </button>
                                );
                            })}
                        </div>
                    ) : error ? (
                        <p className="text-sm text-status-failed-fg">{error}</p>
                    ) : (
                        <Loader2 className="h-5 w-5 animate-spin text-text-muted" />
                    )}
                </div>

                <footer className="flex items-center gap-3 border-t border-glass-border px-4 py-3">
                    <p className="min-w-0 flex-1 text-xs text-text-muted">{t("split.hint")}</p>
                    {error && objectUrl ? <span className="text-xs text-status-failed-fg">{error}</span> : null}
                    <button
                        type="button"
                        onClick={onClose}
                        className="rounded-full border border-glass-border px-3.5 py-1.5 text-sm text-text-secondary hover:bg-hover-bg"
                    >
                        {t("split.cancel")}
                    </button>
                    <button
                        type="button"
                        disabled={busy || !blob || selected.size === 0}
                        onClick={confirm}
                        className="inline-flex items-center gap-1.5 rounded-full bg-primary px-4 py-1.5 text-sm font-medium text-white disabled:opacity-50"
                    >
                        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Grid2x2 className="h-4 w-4" />}
                        {t("split.confirm", { count: selected.size })}
                    </button>
                </footer>
            </section>
        </div>
    );
}
