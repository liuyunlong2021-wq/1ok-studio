"use client";

import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Loader2, RefreshCw, Copy, Download, FolderOpen, AlertCircle, Scissors } from "lucide-react";
import { useTranslations } from "next-intl";

import { api, VideoTask } from "@/lib/api";
import { revealMedia, saveMedia } from "@/lib/mediaActions";
import { getAssetUrl } from "@/lib/utils";
import { toast } from "@/store/toastStore";
import { useProjectStore } from "@/store/projectStore";
import FrameExtractOverlay from "./FrameExtractOverlay";

interface VideoQueueProps {
    tasks: VideoTask[];
    onRemix: (task: VideoTask) => void;
    /** 截到帧之后交给上层，最终会进「参考图」。不传则不显示截帧按钮。 */
    onExtractFrame?: (task: VideoTask, file: File, name: string) => void;
}

/** 任务的某个时间点 → `HH:MM`（跨天补月/日）。跟用户看后端日志的时间一致（本地时区）。 */
function formatTaskTime(seconds?: number): string {
    if (!seconds) return "";
    const at = new Date(seconds * 1000);
    const now = new Date();
    const clock = `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
    return at.toDateString() === now.toDateString()
        ? clock
        : `${at.getMonth() + 1}/${at.getDate()} ${clock}`;
}

/** 两时间点之间的时长 → `3 分 12 秒` / `1 小时 4 分`。end 缺省 = 到现在（正在跑）。 */
function formatElapsed(fromSeconds?: number, toSeconds?: number): string {
    if (!fromSeconds) return "";
    const total = Math.max(0, Math.floor((toSeconds || Date.now() / 1000) - fromSeconds));
    const minutes = Math.floor(total / 60);
    if (minutes < 1) return `${total} 秒`;
    if (minutes < 60) return `${minutes} 分 ${total % 60} 秒`;
    return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`;
}

export default function VideoQueue({ tasks, onRemix, onExtractFrame }: VideoQueueProps) {
    const tv = useTranslations("video");
    const [filter, setFilter] = useState<"all" | "processing" | "completed" | "failed">("all");

    const filteredTasks = tasks.filter(t => {
        if (filter === "all") return true;
        if (filter === "processing") return t.status === "pending" || t.status === "processing";
        return t.status === filter;
    }).reverse(); // Newest first

    const processingCount = tasks.filter(t => t.status === "pending" || t.status === "processing").length;

    return (
        <div className="h-full flex flex-col bg-surface border-l border-border-subtle">
            {/* Header & Tabs */}
            <div className="p-4 border-b border-border-subtle">
                <div className="flex items-center justify-between mb-4">
                    <h3 className="font-display font-bold text-foreground">{tv("taskQueue")}</h3>
                    <div className="text-xs font-mono text-text-muted flex items-center gap-2">
                        <div className={`w-2 h-2 rounded-full ${processingCount > 0 ? "bg-green-500 animate-pulse" : "bg-gray-600"}`} />
                        GPU: {processingCount > 0 ? "Running" : "Idle"}
                    </div>
                </div>

                <div className="flex bg-glass rounded-lg p-1 gap-1">
                    {([
                        { id: "all", label: tv("all") },
                        { id: "processing", label: tv("processing") },
                        { id: "completed", label: tv("completed") },
                    ] as const).map((tab) => (
                        <button
                            key={tab.id}
                            onClick={() => setFilter(tab.id)}
                            className={`flex-1 py-1.5 text-xs rounded-md transition-colors ${filter === tab.id
                                ? "bg-hover-bg text-foreground font-medium shadow-sm"
                                : "text-text-muted hover:text-text-secondary"
                                }`}
                        >
                            {tab.label}
                        </button>
                    ))}
                </div>
            </div>

            {/* Task List */}
            <div className="flex-1 overflow-y-auto p-4 space-y-4">
                <AnimatePresence mode="popLayout">
                    {filteredTasks.map((task) => (
                        <TaskCard key={task.id} task={task} onRemix={onRemix} onExtractFrame={onExtractFrame} />
                    ))}

                    {filteredTasks.length === 0 && (
                        <div className="text-center py-10 text-text-muted text-sm">
                            {tv("noTasks")}
                        </div>
                    )}
                </AnimatePresence>
            </div>
        </div>
    );
}

function TaskCard({ task, onRemix, onExtractFrame }: { task: VideoTask; onRemix: (t: VideoTask) => void; onExtractFrame?: (t: VideoTask, file: File, name: string) => void }) {
    const [extracting, setExtracting] = useState(false);
    const [mediaAction, setMediaAction] = useState<"download" | "open" | null>(null);
    const [resuming, setResuming] = useState(false);
    const [canceling, setCanceling] = useState(false);
    const tv = useTranslations("video");
    const isCompleted = task.status === "completed";
    const isProcessing = task.status === "processing" || task.status === "pending";
    const isFailed = task.status === "failed";

    /**
     * 「继续回捞」：让后端拿已保存的上游任务号接着等结果。
     *
     * 点完立刻把项目拉一次 —— 后端会把状态翻回 processing，列表就跟着回到「生成中」，
     * 之后由上层已有的轮询接着刷。这里不自己起定时器，避免两套轮询打架。
     */
    const handleResume = async () => {
        if (resuming) return;
        setResuming(true);
        try {
            await api.resumeVideoTask(task.project_id, task.id);
            const fresh = await api.getProject(task.project_id);
            if (fresh) useProjectStore.getState().updateProject(task.project_id, fresh);
            toast.success(tv("resumeStarted"));
        } catch (error) {
            toast.error(tv("resumeFailed"), { body: error instanceof Error ? error.message : undefined });
        } finally {
            setResuming(false);
        }
    };

    /**
     * 取消：只是**不再等它**，上游那条任务不会因此停下（网关没有强制中断的接口）。
     * 所以文案要说实话 —— 跑完了还能用「继续回捞」把结果取回来，钱不会白花。
     */
    const handleCancel = async () => {
        if (canceling) return;
        setCanceling(true);
        try {
            await api.cancelVideoTask(task.project_id, task.id);
            const fresh = await api.getProject(task.project_id);
            if (fresh) useProjectStore.getState().updateProject(task.project_id, fresh);
            toast.success(tv("canceled"));
        } catch (error) {
            toast.error(tv("cancelFailed"), { body: error instanceof Error ? error.message : undefined });
        } finally {
            setCanceling(false);
        }
    };

    const submittedAt = formatTaskTime(task.created_at);
    const startedAt = formatTaskTime(task.started_at);
    const finishedAt = formatTaskTime(task.finished_at);
    // 正在跑：从开始算到现在；已结束：从开始算到结束。父组件 5 秒轮询一次，
    // 这个读数会跟着刷新，不用自己起定时器。
    const elapsed = formatElapsed(task.started_at || task.created_at, task.finished_at);


    const getDisplayUrl = (url: string) => {
        return getAssetUrl(url);
    };

    const mediaUrl = task.video_url ? getDisplayUrl(task.video_url) : "";

    const handleCopy = async () => {
        try {
            await navigator.clipboard.writeText(task.prompt);
            toast.success(tv("promptCopied"));
        } catch {
            toast.error(tv("copyFailed"));
        }
    };

    const handleDownload = async () => {
        if (!task.video_url || mediaAction) return;
        setMediaAction("download");
        try {
            const saved = await saveMedia(task.video_url, mediaUrl);
            if (saved) toast.success(tv("videoSaved"));
        } catch (error) {
            toast.error(tv("downloadFailed"), { body: error instanceof Error ? error.message : undefined });
        } finally {
            setMediaAction(null);
        }
    };

    const handleOpen = async () => {
        if (!task.video_url || mediaAction) return;
        setMediaAction("open");
        try {
            if (!await revealMedia(task.video_url)) {
                window.open(mediaUrl, "_blank", "noopener,noreferrer");
            }
        } catch (error) {
            toast.error(tv("openFailed"), { body: error instanceof Error ? error.message : undefined });
        } finally {
            setMediaAction(null);
        }
    };

    return (
        <motion.div
            layout
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95 }}
            className={`rounded-xl overflow-hidden border transition-all ${isProcessing ? "bg-glass border-glass-border" :
                isFailed ? "bg-red-500/5 border-red-500/20" :
                    "bg-surface border-glass-border hover:border-glass-border"
                }`}
        >
            {/* Processing State (Compact) */}
            {isProcessing && (
                <div className="p-3 flex gap-3 items-center">
                    <div className="w-12 h-12 rounded bg-surface/50 relative overflow-hidden flex-shrink-0">
                        {task.image_url ? (
                            <img
                                src={getDisplayUrl(task.image_url)}
                                alt="Input"
                                className="w-full h-full object-cover opacity-60"
                            />
                        ) : (
                            <div className="w-full h-full flex items-center justify-center bg-purple-900/30 text-purple-400 text-[0.625rem] font-bold">
                                R2V
                            </div>
                        )}
                        <div className="absolute inset-0 flex items-center justify-center">
                            <Loader2 className="animate-spin text-primary" size={16} />
                        </div>
                    </div>
                    <div className="flex-1 min-w-0">
                        <div className="flex justify-between items-center mb-1">
                            <span className="text-xs font-mono text-text-secondary">#{task.id.slice(0, 6)}</span>
                            <span className="text-xs text-primary animate-pulse">
                                {task.status === "pending" ? tv("queued") : tv("generating")}
                            </span>
                        </div>
                        <p className="text-xs text-text-secondary truncate">{task.prompt}</p>
                        {!!task.source_frame_ids?.length && <p className="mt-1 text-[0.625rem] text-text-muted">{task.source_frame_ids.length} 个连续镜头 · {task.reference_image_urls?.length || 0} 张参考图 · {task.duration}s</p>}
                        {/* 时间与用时：出错时拿这两个读数去后端日志里对时间点。 */}
                        <div className="mt-1 flex items-center justify-between gap-2">
                            <span className="font-mono text-[0.59375rem] text-text-muted">
                                {tv("submittedAt", { time: submittedAt })}
                                {elapsed ? ` · ${tv("elapsed", { elapsed })}` : ""}
                            </span>
                            <button
                                onClick={handleCancel}
                                disabled={canceling}
                                title={tv("cancelHint")}
                                className="shrink-0 rounded px-1.5 py-0.5 text-[0.625rem] text-text-muted transition-colors hover:bg-hover-bg hover:text-foreground disabled:opacity-50"
                            >
                                {canceling ? tv("canceling") : tv("cancel")}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Completed State (Detailed) */}
            {isCompleted && (
                <div>
                    {/* Header */}
                    <div className="px-3 py-2 border-b border-border-subtle flex justify-between items-center bg-glass">
                        <span className="text-xs font-mono text-text-muted">#{task.id.slice(0, 6)}</span>
                        {/* 完成时间 + 用时：抽卡挑版本时也能看出哪个是刚出的。 */}
                        {finishedAt && (
                            <span className="font-mono text-[0.59375rem] text-text-muted">
                                {tv("completedAt", { time: finishedAt })}
                                {elapsed ? ` · ${tv("tookTime", { elapsed })}` : ""}
                            </span>
                        )}
                        <div className="flex gap-2">
                            <button
                                onClick={() => onRemix(task)}
                                className="text-xs flex items-center gap-1 text-text-secondary hover:text-foreground transition-colors"
                                title={tv("remixTitle")}
                            >
                                <RefreshCw size={12} /> Remix
                            </button>
                        </div>
                    </div>

                    {/* Visual Comparison */}
                    <div className="flex h-32 relative group">
                        {/* Input Image/Videos (Left) */}
                        <div className="w-1/2 relative border-r border-glass-border">
                            {task.image_url ? (
                                <img src={getDisplayUrl(task.image_url)} alt="Input" className="w-full h-full object-cover" />
                            ) : task.reference_video_urls && task.reference_video_urls.length > 0 ? (
                                /* R2V: Show reference video thumbnails */
                                <div className="w-full h-full grid grid-cols-2 gap-0.5 bg-purple-900/20">
                                    {task.reference_video_urls.slice(0, 4).map((url, idx) => (
                                        <div key={idx} className="relative bg-surface overflow-hidden">
                                            <video
                                                src={getAssetUrl(url)}
                                                className="w-full h-full object-cover"
                                                muted
                                                preload="metadata"
                                            />
                                            <div className="absolute bottom-0.5 left-0.5 bg-purple-600/80 px-1 rounded text-[0.5rem] text-foreground font-bold">
                                                @{String.fromCharCode(65 + idx)}
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            ) : task.reference_image_urls && task.reference_image_urls.length > 0 ? (
                                <div className="grid h-full w-full grid-cols-3 gap-0.5 bg-surface">
                                    {task.reference_image_urls.slice(0, 9).map((url, index) => <div key={`${url}-${index}`} className="relative overflow-hidden"><img src={getAssetUrl(url)} alt={`Reference ${index + 1}`} className="h-full w-full object-cover" /><span className="absolute bottom-0.5 left-0.5 rounded bg-overlay px-1 text-[0.5rem] text-foreground">图{index + 1}</span></div>)}
                                </div>
                            ) : (
                                <div className="w-full h-full flex items-center justify-center bg-purple-900/10 text-purple-400/50 text-xs font-bold">
                                    R2V Input
                                </div>
                            )}
                            <div className="absolute top-2 left-2 bg-surface px-1.5 py-0.5 rounded text-[0.625rem] text-text-secondary">Input</div>
                        </div>

                        {/* Output Video (Right) */}
                        <div className="w-1/2 relative bg-black">
                            {task.video_url ? (
                                <video
                                    src={getAssetUrl(task.video_url)}
                                    controls
                                    className="w-full h-full object-cover"
                                />
                            ) : (
                                <div className="w-full h-full flex items-center justify-center text-red-500 text-xs">
                                    Error
                                </div>
                            )}
                            <div className="absolute top-2 right-2 bg-primary/80 px-1.5 py-0.5 rounded text-[0.625rem] text-foreground">Result</div>
                        </div>
                    </div>

                    {/* Prompt & Actions */}
                    <div className="p-3">
                        {!!task.source_frame_ids?.length && <p className="mb-2 text-[0.625rem] text-primary">{task.source_frame_ids.length} 个连续镜头 · {task.reference_image_urls?.length || 0} 张参考图 · {task.skill_name || "Motion Skill"}</p>}
                        <p className="text-xs text-text-secondary line-clamp-2 mb-3 hover:line-clamp-none transition-all cursor-help">
                            {task.prompt}
                        </p>

                        <div className="flex justify-between items-center">
                            <div className="flex gap-2">
                                {/* 截帧：取任意一帧当下一段的位置关系参考 */}
                                {onExtractFrame && task.video_url && (
                                    <button
                                        onClick={() => setExtracting(true)}
                                        title={tv("extractFrame")}
                                        className="p-1.5 hover:bg-hover-bg rounded text-text-secondary hover:text-foreground"
                                    >
                                        <Scissors size={14} />
                                    </button>
                                )}
                                <button
                                    type="button"
                                    onClick={handleCopy}
                                    aria-label={tv("copyPrompt")}
                                    title={tv("copyPrompt")}
                                    className="p-1.5 hover:bg-hover-bg rounded text-text-secondary hover:text-foreground"
                                >
                                    <Copy size={14} />
                                </button>
                                <button
                                    type="button"
                                    onClick={handleDownload}
                                    disabled={!task.video_url || mediaAction !== null}
                                    aria-label={tv("downloadVideo")}
                                    title={tv("downloadVideo")}
                                    className="p-1.5 hover:bg-hover-bg rounded text-text-secondary hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                                >
                                    {mediaAction === "download" ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
                                </button>
                                <button
                                    type="button"
                                    onClick={handleOpen}
                                    disabled={!task.video_url || mediaAction !== null}
                                    aria-label={tv("openVideoFile")}
                                    title={tv("openVideoFile")}
                                    className="p-1.5 hover:bg-hover-bg rounded text-text-secondary hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                                >
                                    {mediaAction === "open" ? <Loader2 size={14} className="animate-spin" /> : <FolderOpen size={14} />}
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {extracting && task.video_url && (
                <FrameExtractOverlay
                    videoPath={task.video_url}
                    label={`#${task.id.slice(0, 6)}`}
                    onClose={() => setExtracting(false)}
                    onExtract={(file, name) => onExtractFrame?.(task, file, name)}
                />
            )}

            {/* Failed State */}
            {isFailed && (
                <div className="p-3">
                    <div className="flex items-center gap-2 text-red-400 mb-2">
                        <AlertCircle size={16} />
                        <span className="text-sm font-medium">{tv("genFailed")}</span>
                        {/* 失败时间点 + 用时：跟后端日志对得上的两个读数。 */}
                        {finishedAt && (
                            <span className="ml-auto font-mono text-[0.59375rem] text-text-muted">
                                {tv("failedAt", { time: finishedAt })}
                                {elapsed ? ` · ${tv("tookTime", { elapsed })}` : ""}
                            </span>
                        )}
                    </div>
                    <p className="text-xs text-text-muted mb-3">{task.error || tv("unknownError")}</p>
                    {/* 有上游任务号时，先给「继续回捞」：上游可能还在跑或已经跑完，
                        接着等就行 —— 重新生成会再付一次费。 */}
                    {task.provider_task_id ? (
                        <div className="space-y-2">
                            <button
                                onClick={handleResume}
                                disabled={resuming}
                                className="w-full py-1.5 rounded text-xs font-medium bg-primary/15 text-primary border border-primary/30 hover:bg-primary/25 transition-colors disabled:opacity-50"
                            >
                                {resuming ? tv("resuming") : tv("resumeTask")}
                            </button>
                            <p className="text-[0.625rem] text-text-muted">{tv("resumeHint")}</p>
                            <button
                                onClick={() => onRemix(task)}
                                className="w-full py-1.5 bg-glass hover:bg-hover-bg rounded text-xs text-text-muted transition-colors"
                            >
                                {tv("retryTaskPlain")}
                            </button>
                        </div>
                    ) : (
                        <button
                            onClick={() => onRemix(task)}
                            className="w-full py-1.5 bg-glass hover:bg-hover-bg rounded text-xs text-text-secondary transition-colors"
                        >
                            {tv("retryTask")}
                        </button>
                    )}
                </div>
            )}
        </motion.div>
    );
}
