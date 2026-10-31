"use client";

import { useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { FolderOpen, FileText, Loader2, X, Upload, Check, AlertTriangle } from "lucide-react";
import { useTranslations } from "next-intl";
import { api } from "@/lib/api";
import { scriptEditorApi } from "@/lib/scriptEditorApi";
import {
    parseEpisodeFiles, planAction,
    type EpisodeDraft, type ImportAction, type ImportSourceFile, type SkippedFile,
} from "@/lib/episodeImport";

interface ExistingEpisode {
    id: string;
    episode_number?: number;
    original_text?: string;
    originalText?: string;
}

interface ImportEpisodesDialogProps {
    isOpen: boolean;
    onClose: () => void;
    seriesId: string;
    workflowMode: string;
    productionWorkflow?: string;
    existingEpisodes: ExistingEpisode[];
    onImported: () => void;
}

interface Row {
    draft: EpisodeDraft;
    chosen: number;
    title: string;
    action: ImportAction;
    existingId?: string;
    /** 已有正文的集：只有勾选覆盖才会写入 */
    overwrite: boolean;
    include: boolean;
}

type Stage = "pick" | "preview" | "running" | "done";

const ACCEPT = ".md,.markdown,.txt";

/** 拖拽的文件夹要递归读目录条目；不支持 webkitGetAsEntry 时退回扁平文件列表。 */
async function readDropped(items: DataTransferItemList, fallback: FileList): Promise<ImportSourceFile[]> {
    const out: ImportSourceFile[] = [];
    const walk = async (entry: FileSystemEntry, prefix: string): Promise<void> => {
        if (entry.isFile) {
            const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject));
            out.push({ path: `${prefix}${entry.name}`, text: await file.text() });
        } else if (entry.isDirectory) {
            const reader = (entry as FileSystemDirectoryEntry).createReader();
            for (;;) {
                const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
                if (!batch.length) break;
                for (const child of batch) await walk(child, `${prefix}${entry.name}/`);
            }
        }
    };
    const entries = Array.from(items).map((item) => item.webkitGetAsEntry?.()).filter(Boolean) as FileSystemEntry[];
    if (entries.length) {
        for (const entry of entries) await walk(entry, "");
        return out;
    }
    return Promise.all(Array.from(fallback).map(async (file) => ({ path: file.name, text: await file.text() })));
}

async function readPicked(files: FileList): Promise<ImportSourceFile[]> {
    return Promise.all(Array.from(files).map(async (file) => ({
        path: (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name,
        text: await file.text(),
    })));
}

export default function ImportEpisodesDialog({
    isOpen, onClose, seriesId, workflowMode, productionWorkflow, existingEpisodes, onImported,
}: ImportEpisodesDialogProps) {
    const t = useTranslations("series.importEpisodes");
    const [stage, setStage] = useState<Stage>("pick");
    const [rows, setRows] = useState<Row[]>([]);
    const [skipped, setSkipped] = useState<SkippedFile[]>([]);
    const [error, setError] = useState<string | null>(null);
    const [progress, setProgress] = useState({ done: 0, total: 0 });
    const [failures, setFailures] = useState<{ number: number; message: string }[]>([]);
    const [dragOver, setDragOver] = useState(false);
    const folderRef = useRef<HTMLInputElement>(null);
    const filesRef = useRef<HTMLInputElement>(null);

    const existingInfo = useMemo(() => existingEpisodes.map((ep) => ({
        id: ep.id,
        episodeNumber: ep.episode_number ?? 0,
        hasText: Boolean((ep.original_text ?? ep.originalText ?? "").trim()),
    })), [existingEpisodes]);

    const reset = () => {
        setStage("pick"); setRows([]); setSkipped([]); setError(null); setFailures([]);
        setProgress({ done: 0, total: 0 });
    };
    const close = () => { reset(); onClose(); };

    const load = (files: ImportSourceFile[]) => {
        setError(null);
        const parsed = parseEpisodeFiles(files);
        if (!parsed.episodes.length) {
            setError(t("noEpisodes"));
            return;
        }
        setSkipped(parsed.skipped);
        setRows(parsed.episodes.map((draft) => {
            const plan = planAction(draft.number, existingInfo);
            return {
                draft, chosen: 0, title: draft.candidates[0].title, ...plan,
                overwrite: false, include: plan.action !== "existing",
            };
        }));
        setStage("preview");
    };

    const handlePicked = async (files: FileList | null) => {
        if (!files?.length) return;
        try { load(await readPicked(files)); } catch { setError(t("readFailed")); }
    };

    const handleDrop = async (event: React.DragEvent) => {
        event.preventDefault();
        setDragOver(false);
        try { load(await readDropped(event.dataTransfer.items, event.dataTransfer.files)); } catch { setError(t("readFailed")); }
    };

    const patch = (index: number, change: Partial<Row>) =>
        setRows((prev) => prev.map((row, i) => (i === index ? { ...row, ...change } : row)));

    const selected = rows.filter((row) => row.include && (row.action !== "existing" || row.overwrite));

    const runImport = async () => {
        setStage("running");
        setFailures([]);
        setProgress({ done: 0, total: selected.length });
        const failed: { number: number; message: string }[] = [];
        for (const row of selected) {
            const text = row.draft.candidates[row.chosen].text;
            try {
                let targetId = row.existingId;
                if (!targetId) {
                    const episode = await api.createEpisodeForSeries(
                        seriesId, row.title.trim() || `EP${row.draft.number}`, row.draft.number, workflowMode, productionWorkflow,
                    );
                    targetId = episode.id;
                }
                // 只填「剧本」(original_text)；工程剧本等后续步骤由用户按原流程推进。
                await scriptEditorApi.updateScriptText(targetId as string, text);
            } catch (reason) {
                failed.push({ number: row.draft.number, message: reason instanceof Error ? reason.message : String(reason) });
            }
            setProgress((p) => ({ ...p, done: p.done + 1 }));
        }
        setFailures(failed);
        setStage("done");
        onImported();
    };

    const actionLabel = (row: Row) =>
        row.action === "create" ? t("actionCreate") : row.action === "fill" ? t("actionFill") : t("actionExisting");

    return (
        <AnimatePresence>
            {isOpen && (
                <motion.div
                    className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
                    initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                    onClick={stage === "running" ? undefined : close}
                >
                    <motion.div
                        role="dialog" aria-modal="true" aria-label={t("title")}
                        className="flex max-h-[88vh] w-[min(760px,94vw)] flex-col overflow-hidden rounded-2xl border border-glass-border bg-surface shadow-2xl"
                        initial={{ scale: 0.97, y: 8 }} animate={{ scale: 1, y: 0 }} exit={{ scale: 0.97, opacity: 0 }}
                        onClick={(e) => e.stopPropagation()}
                    >
                        <header className="flex items-center gap-2 border-b border-glass-border px-5 py-3.5">
                            <Upload size={16} className="text-text-secondary" />
                            <h2 className="text-sm font-semibold text-foreground">{t("title")}</h2>
                            <button onClick={close} disabled={stage === "running"} aria-label={t("close")}
                                className="ml-auto grid h-7 w-7 place-items-center rounded-md text-text-muted hover:bg-hover-bg hover:text-foreground disabled:opacity-40">
                                <X size={16} />
                            </button>
                        </header>

                        {stage === "pick" && (
                            <div className="p-5">
                                <div
                                    onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                                    onDragLeave={() => setDragOver(false)}
                                    onDrop={handleDrop}
                                    className={`flex flex-col items-center gap-4 rounded-xl border-2 border-dashed px-6 py-12 text-center transition ${dragOver ? "border-primary bg-primary/5" : "border-glass-border"}`}
                                >
                                    <p className="text-sm text-text-secondary">{t("dropHint")}</p>
                                    <div className="flex gap-3">
                                        <button onClick={() => folderRef.current?.click()}
                                            className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary/90">
                                            <FolderOpen size={15} />{t("pickFolder")}
                                        </button>
                                        <button onClick={() => filesRef.current?.click()}
                                            className="inline-flex items-center gap-1.5 rounded-lg border border-glass-border px-4 py-2 text-sm text-text-secondary hover:bg-hover-bg">
                                            <FileText size={15} />{t("pickFiles")}
                                        </button>
                                    </div>
                                    <p className="text-xs text-text-muted">{t("formats")}</p>
                                </div>
                                {error && <p className="mt-3 text-sm text-status-failed-fg">{error}</p>}
                                <input ref={folderRef} type="file" className="hidden"
                                    // @ts-expect-error webkitdirectory 不在 React 的类型里
                                    webkitdirectory="" directory=""
                                    onChange={(e) => { void handlePicked(e.target.files); e.target.value = ""; }} />
                                <input ref={filesRef} type="file" multiple accept={ACCEPT} className="hidden"
                                    onChange={(e) => { void handlePicked(e.target.files); e.target.value = ""; }} />
                            </div>
                        )}

                        {stage === "preview" && (
                            <>
                                <div className="min-h-0 flex-1 overflow-y-auto px-5 py-3">
                                    <ul className="space-y-2">
                                        {rows.map((row, index) => {
                                            const candidate = row.draft.candidates[row.chosen];
                                            const blocked = row.action === "existing" && !row.overwrite;
                                            return (
                                                <li key={row.draft.number}
                                                    className={`rounded-lg border border-glass-border px-3 py-2.5 ${blocked ? "opacity-60" : ""}`}>
                                                    <div className="flex items-center gap-2">
                                                        <input type="checkbox" aria-label={`EP${row.draft.number}`}
                                                            checked={row.include && !blocked}
                                                            disabled={blocked}
                                                            onChange={(e) => patch(index, { include: e.target.checked })} />
                                                        <span className="w-12 shrink-0 font-mono text-xs text-text-muted">EP{row.draft.number}</span>
                                                        <input value={row.title}
                                                            disabled={row.action !== "create"}
                                                            onChange={(e) => patch(index, { title: e.target.value })}
                                                            className="min-w-0 flex-1 rounded-md border border-transparent bg-transparent px-2 py-1 text-sm text-foreground hover:border-glass-border focus:border-primary focus:outline-none disabled:hover:border-transparent" />
                                                        <span className="shrink-0 font-mono text-xs text-text-muted">{t("chars", { count: candidate.text.length })}</span>
                                                        <span className={`shrink-0 rounded-full px-2 py-0.5 text-[0.6875rem] ${row.action === "existing" ? "bg-status-failed-bg text-status-failed-fg" : "bg-primary/10 text-primary"}`}>
                                                            {actionLabel(row)}
                                                        </span>
                                                    </div>
                                                    {row.action === "existing" && (
                                                        <label className="mt-1.5 flex items-center gap-1.5 pl-6 text-xs text-text-secondary">
                                                            <input type="checkbox" checked={row.overwrite}
                                                                onChange={(e) => patch(index, { overwrite: e.target.checked, include: e.target.checked })} />
                                                            {t("overwrite")}
                                                        </label>
                                                    )}
                                                    {row.draft.candidates.length > 1 && (
                                                        <div className="mt-1.5 flex items-center gap-2 pl-6 text-xs text-text-secondary">
                                                            <AlertTriangle size={12} className="text-amber-400" />
                                                            <span>{t("conflict")}</span>
                                                            <select value={row.chosen}
                                                                onChange={(e) => patch(index, { chosen: Number(e.target.value), title: row.draft.candidates[Number(e.target.value)].title })}
                                                                className="rounded-md border border-glass-border bg-surface px-1.5 py-0.5">
                                                                {row.draft.candidates.map((c, i) => (
                                                                    <option key={c.source} value={i}>{c.source} · {t("chars", { count: c.text.length })}</option>
                                                                ))}
                                                            </select>
                                                        </div>
                                                    )}
                                                    {row.draft.mergedSources.length > 0 && (
                                                        <p className="mt-1 pl-6 text-[0.6875rem] text-text-muted">{t("merged", { files: row.draft.mergedSources.join("、") })}</p>
                                                    )}
                                                </li>
                                            );
                                        })}
                                    </ul>
                                    {skipped.length > 0 && (
                                        <p className="mt-3 text-xs text-text-muted">
                                            {t("skipped", { count: skipped.length })}：{skipped.map((s) => s.path.split("/").pop()).join("、")}
                                        </p>
                                    )}
                                </div>
                                <footer className="flex items-center gap-3 border-t border-glass-border px-5 py-3">
                                    <button onClick={reset} className="text-sm text-text-secondary hover:text-foreground">{t("back")}</button>
                                    <span className="ml-auto text-xs text-text-muted">{t("summary", { count: selected.length })}</span>
                                    <button onClick={runImport} disabled={selected.length === 0}
                                        className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary/90 disabled:opacity-50">
                                        {t("import", { count: selected.length })}
                                    </button>
                                </footer>
                            </>
                        )}

                        {stage === "running" && (
                            <div className="flex flex-col items-center gap-3 px-5 py-14">
                                <Loader2 className="h-6 w-6 animate-spin text-primary" />
                                <p className="text-sm text-foreground">{t("running", { done: progress.done, total: progress.total })}</p>
                            </div>
                        )}

                        {stage === "done" && (
                            <div className="flex flex-col items-center gap-3 px-5 py-10 text-center">
                                <Check className="h-6 w-6 text-primary" />
                                <p className="text-sm text-foreground">{t("done", { count: progress.total - failures.length })}</p>
                                {failures.length > 0 && (
                                    <ul className="max-h-40 w-full overflow-y-auto rounded-lg border border-glass-border p-3 text-left text-xs text-status-failed-fg">
                                        {failures.map((f) => <li key={f.number}>EP{f.number}：{f.message}</li>)}
                                    </ul>
                                )}
                                <button onClick={close} className="mt-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary/90">{t("finish")}</button>
                            </div>
                        )}
                    </motion.div>
                </motion.div>
            )}
        </AnimatePresence>
    );
}
