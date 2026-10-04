"use client";

import { useState, useRef, useEffect, Fragment } from "react";
import { useTranslations } from "next-intl";
import { motion, AnimatePresence } from "framer-motion";
import {
    Layout, Image as ImageIcon,
    Trash2, Copy, Wand2, FileText, RefreshCw, Loader2, X, Lock, Unlock,
    Plus, ArrowUp, ArrowDown, Zap, Upload, Film
} from "lucide-react";
import { useProjectStore } from "@/store/projectStore";
import { api, crudApi, type EngineeringSyncPreview as SyncPreview } from "@/lib/api";
import { getAssetUrlWithTimestamp, extractErrorDetail } from "@/lib/utils";
import { selectedVariantUrl } from "@/lib/characterImage";
import StepHeader from "@/components/shared/StepHeader";
import WorkflowActionButton from "@/components/shared/WorkflowActionButton";

import StoryboardFrameEditor from "./StoryboardFrameEditor";
import EngineeringSyncPreview from "./EngineeringSyncPreview";
import EngineeringArchives from "./EngineeringArchives";

export default function StoryboardComposer() {
    const t = useTranslations("storyboard");
    const tStep = useTranslations("stepHeader");
    const currentProject = useProjectStore((state) => state.currentProject);
    const selectedFrameId = useProjectStore((state) => state.selectedFrameId);
    const setSelectedFrameId = useProjectStore((state) => state.setSelectedFrameId);
    const updateProject = useProjectStore((state) => state.updateProject);

    // Use global rendering state (persists across module switches)
    const renderingFrames = useProjectStore((state) => state.renderingFrames);
    const addRenderingFrame = useProjectStore((state) => state.addRenderingFrame);
    const removeRenderingFrame = useProjectStore((state) => state.removeRenderingFrame);

    // Use global storyboard analysis state (persists across tab switches)
    const isAnalyzing = useProjectStore((state) => state.isAnalyzingStoryboard);
    const setIsAnalyzing = useProjectStore((state) => state.setIsAnalyzingStoryboard);

    const [editingFrameId, setEditingFrameId] = useState<string | null>(null);
    const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
    const [insertIndex, setInsertIndex] = useState<number | null>(null);
    const [extractingFrameId, setExtractingFrameId] = useState<string | null>(null);
    const [showScriptOverlay, setShowScriptOverlay] = useState(false);
    const [engineeringStatus, setEngineeringStatus] = useState<Awaited<ReturnType<typeof api.getEngineeringStatus>> | null>(null);
    const [syncPreview, setSyncPreview] = useState<SyncPreview | null>(null);
    const [engineeringError, setEngineeringError] = useState('');
    const [showArchives, setShowArchives] = useState(false);
    const engineeringOwned = !!currentProject?.storyboard_source_revision;
    const timecode = (value: number) => `${Math.floor(value / 60).toString().padStart(2, '0')}:${(value % 60).toString().padStart(2, '0')}`;

    useEffect(() => {
        let cancelled = false;
        setEngineeringStatus(null); setEngineeringError('');
        setSyncPreview(null); setShowArchives(false);
        if (currentProject?.id) api.getEngineeringStatus(currentProject.id)
            .then(status => { if (!cancelled) setEngineeringStatus(status); })
            .catch(error => { if (!cancelled) setEngineeringError(extractErrorDetail(error, '台本状态读取失败')); });
        return () => { cancelled = true; };
    }, [currentProject?.id, currentProject?.originalText, currentProject?.engineering_script?.revision, currentProject?.storyboard_source_revision]);

    const fileInputRef = useRef<HTMLInputElement>(null);
    const [uploadTargetFrameId, setUploadTargetFrameId] = useState<string | null>(null);



    const handleAnalyzeToStoryboard = async () => {
        if (!currentProject) return;
        setIsAnalyzing(true); setEngineeringError('');
        try { setSyncPreview(await api.previewEngineeringSync(currentProject.id)); }
        catch (error) { setEngineeringError(extractErrorDetail(error, '工程台本读取失败')); }
        finally { setIsAnalyzing(false); }
    };

    const handleReviewed = async (frameId: string) => {
        if (!currentProject) return;
        try { updateProject(currentProject.id, await api.reviewEngineeringFrame(currentProject.id, frameId)); }
        catch (error) { setEngineeringError(extractErrorDetail(error, '复核状态保存失败')); }
    };

    const handleImageClick = (frameId: string, e: React.MouseEvent) => {
        e.stopPropagation();
        setEditingFrameId(frameId);
    };

    const handleDeleteFrame = async (frameId: string, e: React.MouseEvent) => {
        e.stopPropagation();
        if (!currentProject) return;
        if (!confirm(t("confirmDeleteFrame"))) return;

        try {
            await crudApi.deleteFrame(currentProject.id, frameId);
            const updatedProject = await api.getProject(currentProject.id);
            updateProject(currentProject.id, updatedProject);
        } catch (error) {
            console.error("Failed to delete frame:", error);
            alert(t("deleteFrameFailed"));
        }
    };

    const handleCopyFrame = async (frameId: string, e: React.MouseEvent) => {
        e.stopPropagation();
        if (!currentProject) return;

        try {
            await crudApi.copyFrame(currentProject.id, frameId);
            const updatedProject = await api.getProject(currentProject.id);
            updateProject(currentProject.id, updatedProject);
        } catch (error) {
            console.error("Failed to copy frame:", error);
            alert(t("copyFrameFailed"));
        }
    };

    const handleCreateFrame = async (data: any) => {
        if (!currentProject) return;

        try {
            await crudApi.createFrame(currentProject.id, {
                ...data,
                insert_at: insertIndex !== null ? insertIndex : undefined
            });
            const updatedProject = await api.getProject(currentProject.id);
            updateProject(currentProject.id, updatedProject);
            setIsCreateDialogOpen(false);
            setInsertIndex(null);
        } catch (error) {
            console.error("Failed to create frame:", error);
            alert(t("createFrameFailed"));
        }
    };

    const handleMoveFrame = async (index: number, direction: 'up' | 'down', e: React.MouseEvent) => {
        e.stopPropagation();
        if (!currentProject || !currentProject.frames) return;

        const newIndex = direction === 'up' ? index - 1 : index + 1;
        if (newIndex < 0 || newIndex >= currentProject.frames.length) return;

        // Create new order
        const newFrames = [...currentProject.frames];
        const [movedFrame] = newFrames.splice(index, 1);
        newFrames.splice(newIndex, 0, movedFrame);

        const newOrderIds = newFrames.map((f: any) => f.id);

        try {
            // Optimistic update
            updateProject(currentProject.id, { ...currentProject, frames: newFrames });

            await crudApi.reorderFrames(currentProject.id, newOrderIds);
            // No need to fetch again if optimistic update was correct, but good for safety
        } catch (error) {
            console.error("Failed to reorder frames:", error);
            alert(t("reorderFailed"));
            // Revert on error would be ideal here by fetching project again
            const project = await api.getProject(currentProject.id);
            updateProject(currentProject.id, project);
        }
    };

    const handleExtractLastFrame = async (frameId: string, e: React.MouseEvent) => {
        e.stopPropagation();
        if (!currentProject?.frames) return;

        const frameIndex = currentProject.frames.findIndex((f: any) => f.id === frameId);
        if (frameIndex <= 0) return;

        // Find the previous frame's selected video
        const prevFrame = currentProject.frames[frameIndex - 1];
        if (!prevFrame.selected_video_id) {
            alert("Previous frame has no selected video.");
            return;
        }

        const prevVideo = currentProject.video_tasks?.find(
            (t: any) => t.id === prevFrame.selected_video_id && t.status === "completed"
        );
        if (!prevVideo) {
            alert("Previous frame's video is not completed yet.");
            return;
        }

        setExtractingFrameId(frameId);
        try {
            const updatedProject = await api.extractLastFrame(currentProject.id, frameId, prevVideo.id);
            updateProject(currentProject.id, updatedProject);
        } catch (error: any) {
            console.error("Failed to extract last frame:", error);
            alert(error?.response?.data?.detail || "Failed to extract last frame");
        } finally {
            setExtractingFrameId(null);
        }
    };

    const handleUploadFrameImage = async (frameId: string, e: React.MouseEvent) => {
        e.stopPropagation();
        setUploadTargetFrameId(frameId);
        fileInputRef.current?.click();
    };

    const handleFileSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file || !uploadTargetFrameId || !currentProject) return;

        try {
            const updatedProject = await api.uploadFrameImage(currentProject.id, uploadTargetFrameId, file);
            updateProject(currentProject.id, updatedProject);
        } catch (error: any) {
            console.error("Failed to upload frame image:", error);
            alert(error?.message || "Failed to upload frame image");
        } finally {
            setUploadTargetFrameId(null);
            if (fileInputRef.current) fileInputRef.current.value = "";
        }
    };

    const handleRenderFrame = async (frame: any, batchSize: number = 1, e?: React.MouseEvent) => {
        e?.stopPropagation();
        if (!currentProject) return;

        addRenderingFrame(frame.id);
        try {
            // Construct composition data with references
            const compositionData: any = {
                character_ids: frame.character_ids,
                prop_ids: frame.prop_ids,
                scene_id: frame.scene_id,
                reference_image_urls: []
            };

            // Helper to get selected variant URL from an asset
            const getSelectedVariantUrl = (asset: any): string | null => {
                if (!asset || !asset.variants || asset.variants.length === 0) return null;

                // Try to get selected variant first
                if (asset.selected_id) {
                    const selectedVariant = asset.variants.find((v: any) => v.id === asset.selected_id);
                    if (selectedVariant?.url) return selectedVariant.url;
                }

                // Fallback: auto-select first variant if no selection exists
                // This handles the case where selected_id is null/undefined
                return asset.variants[0]?.url || null;
            };

            // 1. Add Scene Image - prioritize selected variant
            if (frame.scene_id) {
                const scene = currentProject.scenes?.find((s: any) => s.id === frame.scene_id);
                if (scene) {
                    const sceneUrl = getSelectedVariantUrl(scene.image_asset) || scene.image_url;
                    if (sceneUrl) compositionData.reference_image_urls.push(sceneUrl);
                }
            }

            // 2. Add Character Images - use selected variant from three_view > full_body > headshot
            if (frame.character_ids && frame.character_ids.length > 0) {
                frame.character_ids.forEach((charId: string) => {
                    const char = currentProject.characters?.find((c: any) => c.id === charId);
                    if (char) {
                        // Priority: three_view_asset > full_body_asset > headshot_asset > legacy fields
                        const charUrl = selectedVariantUrl(char.reference_sheet)
                            || getSelectedVariantUrl(char.three_view_asset)
                            || getSelectedVariantUrl(char.full_body_asset)
                            || getSelectedVariantUrl(char.headshot_asset)
                            || char.three_view_image_url
                            || char.full_body_image_url
                            || char.headshot_image_url
                            || char.avatar_url
                            || char.image_url;
                        if (charUrl) compositionData.reference_image_urls.push(charUrl);
                    }
                });
            }

            // 3. Add Prop Images - prioritize selected variant
            if (frame.prop_ids && frame.prop_ids.length > 0) {
                frame.prop_ids.forEach((propId: string) => {
                    const prop = currentProject.props?.find((p: any) => p.id === propId);
                    if (prop) {
                        const propUrl = getSelectedVariantUrl(prop.image_asset) || prop.image_url;
                        if (propUrl) compositionData.reference_image_urls.push(propUrl);
                    }
                });
            }

            // Construct enhanced prompt using Art Direction style config.
            const artDirection = currentProject?.art_direction;
            const globalStylePrompt = artDirection?.style_config?.positive_prompt || "";

            // Construct final prompt:
            // If image_prompt exists (polished or manually edited), it already contains action/dialogue,
            // so only prepend the style. Otherwise, build from action_description and dialogue.
            let finalPrompt = "";

            if (frame.image_prompt && frame.image_prompt.trim()) {
                // User has a custom/polished prompt - only add style prefix
                finalPrompt = globalStylePrompt
                    ? `${globalStylePrompt} . ${frame.image_prompt}`
                    : frame.image_prompt;
            } else {
                // No custom prompt - build from action_description and dialogue
                const parts = [
                    globalStylePrompt,
                    frame.visual_description || frame.action_description,
                    frame.dialogue ? `Dialogue context: "${frame.dialogue}"` : ""
                ].filter(Boolean);
                finalPrompt = parts.join(" . ");
            }

            await api.renderFrame(currentProject.id, frame.id, compositionData, finalPrompt, batchSize);

            // Fetch updated project to get new image URL and timestamp
            const updatedProject = await api.getProject(currentProject.id);
            useProjectStore.getState().updateProject(currentProject.id, updatedProject);

        } catch (error) {
            console.error("Render failed:", error);
            alert("Render failed. See console for details.");
        } finally {
            removeRenderingFrame(frame.id);
        }
    };

    return (
        <div className="flex flex-col h-full text-foreground overflow-hidden">
            <StepHeader
                stepNumber={4}
                totalSteps={6}
                icon={<Layout />}
                englishName="Storyboard Composer"
                title={tStep("storyboardComposerTitle")}
                subtitle={tStep("storyboardComposerSubtitle")}
                trailing={(
                    <div className="flex items-center gap-2">
                        <span className="font-mono text-[0.625rem] uppercase tracking-[0.18em] text-text-muted">
                            <span className="text-foreground font-medium">{currentProject?.frames?.length || 0}</span>
                            <span className="ml-1.5">frames</span>
                        </span>
                        <WorkflowActionButton
                            variant="ghost"
                            size="sm"
                            leftIcon={<FileText />}
                            onClick={() => setShowScriptOverlay(true)}
                            title={t("viewOriginalScript")}
                        >
                            {t("viewScript")}
                        </WorkflowActionButton>
                        <WorkflowActionButton
                            variant="primary"
                            size="sm"
                            leftIcon={isAnalyzing ? undefined : <Zap />}
                            loading={isAnalyzing}
                            onClick={handleAnalyzeToStoryboard}
                            disabled={isAnalyzing}
                            title="逐镜读取已确认台本，预览后同步"
                        >
                            {isAnalyzing ? "读取台本…" : engineeringOwned ? "预览同步分镜" : "从工程台本生成分镜"}
                        </WorkflowActionButton>
                    </div>
                )}
            />
            <div className="shrink-0 border-b border-border-subtle px-8 py-2 text-xs text-text-muted">
                <div className="flex flex-wrap items-center justify-between gap-2">
                    <span>{engineeringStatus?.current ? `确认台本：${engineeringStatus.count}镜 · ${engineeringStatus.duration}秒 · ${engineeringStatus.synced ? '已同步' : '待预览同步'}` : engineeringStatus?.confirmed ? '剧本已修改，请回剧本确认节奏后同步' : '先在剧本阶段生成带时间码的工程台本，并点击「确认工程台本」'}{engineeringOwned ? ' · 镜头增删、顺序和节奏在剧本阶段调整' : ''}</span>
                    {!!currentProject?.storyboard_archives?.length && <button type="button" onClick={() => setShowArchives(true)} className="text-primary">查看旧分镜归档（{currentProject.storyboard_archives.length}）</button>}
                </div>
                {engineeringError && <p role="alert" className="mt-1 whitespace-pre-wrap text-red-400">{engineeringError}</p>}
            </div>

            {/* Frame List — full width */}
            <div className="flex-1 overflow-y-auto p-8">
                <div className="max-w-4xl mx-auto space-y-6">
                        {/* Add Frame Button (Top) */}
                        {!engineeringOwned && <div className="flex justify-center">
                            <button
                                onClick={() => { setInsertIndex(0); setIsCreateDialogOpen(true); }}
                                className="flex items-center gap-2 px-4 py-2 bg-glass hover:bg-hover-bg text-text-secondary hover:text-foreground rounded-lg transition-colors border border-dashed border-glass-border hover:border-glass-border"
                            >
                                <Plus size={16} />
                                <span className="text-sm font-medium">{t("insertFrameAtStart")}</span>
                            </button>
                        </div>}

                        {currentProject?.frames?.map((frame: any, index: number) => (
                            <Fragment key={frame.id}>
                                <motion.div
                                    key={frame.id}
                                    layoutId={frame.id}
                                    onClick={() => setSelectedFrameId(frame.id)}
                                    className={`group relative flex gap-6 p-4 rounded-xl border transition-all cursor-pointer ${selectedFrameId === frame.id
                                        ? "bg-glass border-primary ring-1 ring-primary"
                                        : "bg-surface border-border-subtle hover:border-glass-border"
                                        }`}
                                >
                                    {/* Frame Number */}
                                    <div className="absolute -left-3 -top-3 w-8 h-8 rounded-full bg-elevated border border-glass-border flex items-center justify-center text-xs font-bold text-text-secondary shadow-lg z-10">
                                        {frame.source_shot_number ?? index + 1}
                                    </div>

                                    {/* Image Preview */}
                                    <div className="w-64 aspect-video bg-surface rounded-lg border border-border-subtle overflow-hidden flex-shrink-0 relative">
                                        {frame.rendered_image_url || frame.image_url ? (
                                            <ImageWithRetry
                                                key={frame.id + (frame.updated_at || 0)} // Force remount on refresh
                                                src={getAssetUrlWithTimestamp(frame.rendered_image_url || frame.image_url, frame.updated_at)}
                                                alt={`Frame ${index + 1}`}
                                                className="w-full h-full object-cover cursor-zoom-in"
                                                onClick={(e: React.MouseEvent) => handleImageClick(frame.id, e)}
                                            />
                                        ) : (
                                            <div className="w-full h-full flex flex-col items-center justify-center text-text-muted gap-2">
                                                <ImageIcon size={24} className="opacity-20" />
                                                <span className="text-[0.625rem]">{t("noImage", { defaultMessage: "No Image" })}</span>
                                            </div>
                                        )

                                        }

                                        {/* Hover Actions - pointer-events-none to allow image click */}
                                        <div className="absolute inset-0 bg-overlay opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-2 pointer-events-none">
                                            {/* Lock Button */}
                                            <button
                                                onClick={async (e) => {
                                                    e.stopPropagation();
                                                    if (!currentProject) return;
                                                    try {
                                                        await api.toggleFrameLock(currentProject.id, frame.id);
                                                        const updated = await api.getProject(currentProject.id);
                                                        updateProject(currentProject.id, updated);
                                                    } catch (error) {
                                                        console.error("Toggle lock failed:", error);
                                                    }
                                                }}
                                                className="p-2 bg-glass hover:bg-hover-bg text-foreground rounded-lg text-xs font-bold flex items-center gap-1 pointer-events-auto"
                                                title={frame.locked ? t("unlockFrame") : t("lockFrame")}
                                            >
                                                {frame.locked ? <Unlock size={14} /> : <Lock size={14} />}
                                            </button>

                                            {/* Render Buttons with Batch Size - only show if not locked */}
                                            {!frame.locked && (
                                                <div className="flex items-center gap-1 pointer-events-auto">
                                                    {renderingFrames.has(frame.id) ? (
                                                        <div className="flex items-center gap-2 px-3 py-1.5 bg-gray-700 rounded-lg">
                                                            <Loader2 size={14} className="animate-spin text-white" />
                                                            <span className="text-xs text-foreground">Generating...</span>
                                                        </div>
                                                    ) : (
                                                        <>
                                                            {[1, 2, 3, 4].map(size => (
                                                                <button
                                                                    key={size}
                                                                    onClick={(e) => { e.stopPropagation(); handleRenderFrame(frame, size); }}
                                                                    className="px-2 py-1.5 bg-primary/80 hover:bg-primary text-foreground rounded text-xs font-bold transition-colors"
                                                                    title={`Generate ${size} variant${size > 1 ? 's' : ''}`}
                                                                >
                                                                    <div className="flex items-center gap-1">
                                                                        <Wand2 size={12} />
                                                                        <span>×{size}</span>
                                                                    </div>
                                                                </button>
                                                            ))}
                                                        </>
                                                    )}
                                                </div>
                                            )}
                                        </div>
                                    </div>

                                    {/* Content */}
                                    <div className="flex-1 flex flex-col gap-3">
                                        <div className="flex items-start justify-between">
                                            <div className="space-y-1">
                                                <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
                                                    {frame.source_start != null && frame.source_end != null && <span className="font-mono text-text-muted">{timecode(frame.source_start)}–{timecode(frame.source_end)}</span>}
                                                    {frame.review_required && <button type="button" onClick={e => { e.stopPropagation(); void handleReviewed(frame.id); }} title="检查此镜已有素材是否符合新台本，完成后点击" className="rounded border border-amber-500/40 px-2 py-1 text-amber-500">素材待复核 · 标记已复核</button>}
                                                    <span className="rounded border border-primary/30 bg-primary/10 px-2 py-1 text-primary">景别：{frame.shot_size || '未设置'}</span>
                                                    <span className="rounded border border-border-subtle px-2 py-1 text-text-secondary">机位：{frame.camera_angle || '未设置'}</span>
                                                    <span className="rounded border border-border-subtle px-2 py-1 text-text-secondary">运镜：{frame.camera_movement || '未设置'}</span>
                                                    <span className="rounded border border-border-subtle px-2 py-1 text-text-secondary">时长：{frame.duration ? `${frame.duration}秒` : '未设置'}</span>
                                                </div>
                                                <p className="text-sm text-text-secondary leading-relaxed line-clamp-3">
                                                    {frame.action_description}
                                                </p>
                                                {(frame.source_text || frame.visual_description) && <details className="mt-2 text-xs text-text-muted">
                                                    <summary className="cursor-pointer text-primary">完整镜头设计与表演过程</summary>
                                                    <p className="mt-2 whitespace-pre-wrap leading-relaxed text-text-secondary">{frame.source_text || frame.visual_description}</p>
                                                </details>}
                                            </div>
                                        </div>

                                        {frame.dialogue && (
                                            <div className="mt-auto pt-3 border-t border-border-subtle">
                                                <span className="font-mono text-[0.625rem] font-semibold text-text-secondary uppercase tracking-[0.18em] block mb-1">{t("dialogueLabel")}{frame.speaker ? ` · ${frame.speaker}` : ''}</span>
                                                <p className="text-sm text-text-secondary italic">"{frame.dialogue}"</p>
                                            </div>
                                        )}

                                        {/* Frame Actions */}
                                        <div className="flex justify-end gap-2 mt-2 pt-2 border-t border-border-subtle">
                                            {!engineeringOwned && <div className="flex items-center gap-1 mr-auto">
                                                <button
                                                    onClick={(e) => handleMoveFrame(index, 'up', e)}
                                                    disabled={index === 0}
                                                    className="btn-tip p-2 hover:bg-hover-bg text-text-secondary hover:text-foreground rounded-lg transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                                                    data-tip={t("moveUp")}
                                                >
                                                    <ArrowUp size={14} />
                                                </button>
                                                <button
                                                    onClick={(e) => handleMoveFrame(index, 'down', e)}
                                                    disabled={index === (currentProject.frames?.length || 0) - 1}
                                                    className="btn-tip p-2 hover:bg-hover-bg text-text-secondary hover:text-foreground rounded-lg transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                                                    data-tip={t("moveDown")}
                                                >
                                                    <ArrowDown size={14} />
                                                </button>
                                            </div>}

                                            {!engineeringOwned && <button
                                                onClick={(e) => handleCopyFrame(frame.id, e)}
                                                className="btn-tip p-2 hover:bg-hover-bg text-text-secondary hover:text-foreground rounded-lg transition-colors"
                                                data-tip={t("duplicateFrame")}
                                            >
                                                <Copy size={14} />
                                            </button>}
                                            <button
                                                onClick={(e) => handleUploadFrameImage(frame.id, e)}
                                                className="btn-tip p-2 hover:bg-primary/15 text-text-secondary hover:text-primary rounded-lg transition-colors"
                                                data-tip={t("uploadImage")}
                                            >
                                                <Upload size={14} />
                                            </button>
                                            {index > 0 && (() => {
                                                const prevFrame = currentProject.frames?.[index - 1];
                                                const prevVideoCompleted = prevFrame?.selected_video_id && currentProject.video_tasks?.find(
                                                    (t: any) => t.id === prevFrame.selected_video_id && t.status === "completed"
                                                );
                                                return prevVideoCompleted ? (
                                                    <button
                                                        onClick={(e) => handleExtractLastFrame(frame.id, e)}
                                                        disabled={extractingFrameId === frame.id}
                                                        className="btn-tip p-2 hover:bg-primary/15 text-text-secondary hover:text-primary rounded-lg transition-colors disabled:opacity-50"
                                                        data-tip={t("usePrevEndFrame")}
                                                    >
                                                        {extractingFrameId === frame.id ? <Loader2 size={14} className="animate-spin" /> : <Film size={14} />}
                                                    </button>
                                                ) : null;
                                            })()}
                                            {!engineeringOwned && <button
                                                onClick={(e) => handleDeleteFrame(frame.id, e)}
                                                className="btn-tip p-2 hover:bg-red-500/20 text-text-secondary hover:text-red-400 rounded-lg transition-colors"
                                                data-tip="Delete"
                                            >
                                                <Trash2 size={14} />
                                            </button>}
                                        </div>
                                    </div>
                                </motion.div>

                                {/* Add Button Between Frames */}
                                {!engineeringOwned && <div className="flex justify-center opacity-0 hover:opacity-100 transition-opacity -my-3 z-10 relative" >
                                    <button
                                        onClick={() => { setInsertIndex(index + 1); setIsCreateDialogOpen(true); }}
                                        className="p-1 bg-elevated border border-glass-border rounded-full text-text-secondary hover:text-foreground hover:border-primary hover:bg-primary/20 transition-all transform hover:scale-110"
                                        title={t("insertFrameAtStart")}
                                    >
                                        <Plus size={16} />
                                    </button>
                                </div>}
                            </Fragment>
                        ))}
                </div>
            </div>

            {syncPreview && currentProject && <EngineeringSyncPreview key={syncPreview.token} projectId={currentProject.id} preview={syncPreview} onClose={() => setSyncPreview(null)} onApplied={() => { setSyncPreview(null); setSelectedFrameId(null); }} />}
            {showArchives && currentProject && <EngineeringArchives projectId={currentProject.id} onClose={() => setShowArchives(false)} />}

            {/* Script Overlay */}
            <AnimatePresence>
                {showScriptOverlay && (
                    <motion.div
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        transition={{ duration: 0.2 }}
                        className="absolute inset-0 z-40 flex items-center justify-center bg-overlay backdrop-blur-sm"
                        onClick={() => setShowScriptOverlay(false)}
                    >
                        <motion.div
                            initial={{ opacity: 0, scale: 0.95, y: 16 }}
                            animate={{ opacity: 1, scale: 1, y: 0 }}
                            exit={{ opacity: 0, scale: 0.95, y: 16 }}
                            transition={{ duration: 0.25, ease: [0.25, 1, 0.5, 1] }}
                            className="w-full max-w-2xl max-h-[80vh] bg-surface border border-glass-border rounded-2xl shadow-lg overflow-hidden flex flex-col"
                            onClick={(e) => e.stopPropagation()}
                        >
                            <div className="flex items-center justify-between px-6 py-4 border-b border-glass-border bg-surface">
                                <div className="flex items-center gap-3">
                                    <FileText size={18} className="text-primary" />
                                    <h3 className="text-sm font-bold text-foreground">{t("originalScript")}</h3>
                                </div>
                                <button
                                    onClick={() => setShowScriptOverlay(false)}
                                    className="p-1.5 hover:bg-hover-bg rounded-lg transition-colors"
                                >
                                    <X size={16} className="text-text-secondary" />
                                </button>
                            </div>
                            <div className="flex-1 overflow-y-auto p-6">
                                <pre className="text-sm text-text-secondary whitespace-pre-wrap font-sans leading-relaxed">
                                    {currentProject?.originalText || t("noScriptContent")}
                                </pre>
                            </div>
                        </motion.div>
                    </motion.div>
                )}
            </AnimatePresence>

            {/* Storyboard Frame Editor Modal */}
            <AnimatePresence>
                {editingFrameId && currentProject?.frames?.find((f: any) => f.id === editingFrameId) && (
                    <StoryboardFrameEditor
                        frame={currentProject.frames.find((f: any) => f.id === editingFrameId)}
                        onClose={() => setEditingFrameId(null)}
                    />
                )}
            </AnimatePresence>

            {/* Create Frame Dialog */}
            <AnimatePresence>
                {isCreateDialogOpen && (
                    <CreateFrameDialog
                        onClose={() => { setIsCreateDialogOpen(false); setInsertIndex(null); }}
                        onCreate={handleCreateFrame}
                        scenes={currentProject?.scenes || []}
                    />
                )}
            </AnimatePresence>

            {/* Hidden file input for frame image upload */}
            <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={handleFileSelected}
            />
        </div >
    );
}

function CreateFrameDialog({ onClose, onCreate, scenes }: { onClose: () => void; onCreate: (data: any) => void | Promise<void>; scenes: any[] }) {
    const [action, setAction] = useState("");
    const [dialogue, setDialogue] = useState("");
    const [sceneId, setSceneId] = useState(scenes[0]?.id || "");
    const [isSubmitting, setIsSubmitting] = useState(false);

    const handleSubmit = async () => {
        if (!action.trim()) {
            alert("Action description is required");
            return;
        }
        if (!sceneId && scenes.length > 0) {
            alert("Please select a scene");
            return;
        }

        setIsSubmitting(true);
        try {
            await onCreate({
                action_description: action.trim(),
                dialogue: dialogue.trim(),
                scene_id: sceneId,
                camera_angle: "Medium Shot"
            });
        } finally {
            setIsSubmitting(false);
        }
    };

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-overlay backdrop-blur-sm p-8">
            <motion.div
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.95 }}
                className="bg-surface border border-glass-border rounded-2xl w-full max-w-lg overflow-hidden shadow-lg"
            >
                <div className="p-6 border-b border-glass-border flex justify-between items-center bg-surface">
                    <div className="flex items-center gap-3">
                        <Plus className="text-primary" size={20} />
                        <h2 className="text-lg font-bold text-foreground">Add New Frame</h2>
                    </div>
                    <button onClick={onClose} className="p-2 hover:bg-hover-bg rounded-lg transition-colors">
                        <X size={20} className="text-text-secondary" />
                    </button>
                </div>

                <div className="p-6 space-y-4">
                    <div>
                        <label className="block text-sm font-medium text-text-secondary mb-2">Scene</label>
                        <select
                            value={sceneId}
                            onChange={(e) => setSceneId(e.target.value)}
                            className="w-full px-4 py-3 bg-input-bg border border-glass-border rounded-lg text-foreground focus:border-primary/50 focus:outline-none appearance-none"
                        >
                            <option value="" disabled>Select a scene</option>
                            {scenes.map((s: any) => (
                                <option key={s.id} value={s.id}>{s.name}</option>
                            ))}
                        </select>
                    </div>
                    <div>
                        <label className="block text-sm font-medium text-text-secondary mb-2">Action Description *</label>
                        <textarea
                            value={action}
                            onChange={(e) => setAction(e.target.value)}
                            placeholder="What is happening in this frame?"
                            rows={3}
                            className="w-full px-4 py-3 bg-input-bg border border-glass-border rounded-lg text-foreground placeholder-text-muted focus:border-primary/50 focus:outline-none resize-none"
                        />
                    </div>
                    <div>
                        <label className="block text-sm font-medium text-text-secondary mb-2">Dialogue (Optional)</label>
                        <textarea
                            value={dialogue}
                            onChange={(e) => setDialogue(e.target.value)}
                            placeholder="Character dialogue..."
                            rows={2}
                            className="w-full px-4 py-3 bg-input-bg border border-glass-border rounded-lg text-foreground placeholder-text-muted focus:border-primary/50 focus:outline-none resize-none"
                        />
                    </div>
                </div>

                <div className="p-6 border-t border-glass-border flex justify-end gap-3">
                    <button
                        onClick={onClose}
                        className="px-6 py-2 bg-glass hover:bg-hover-bg text-foreground rounded-lg transition-colors"
                    >
                        Cancel
                    </button>
                    <button
                        onClick={handleSubmit}
                        disabled={isSubmitting || !action.trim()}
                        className="px-6 py-2 bg-primary hover:bg-primary/90 text-white rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
                    >
                        {isSubmitting && <RefreshCw size={16} className="animate-spin" />}
                        Create Frame
                    </button>
                </div>
            </motion.div>
        </div>
    );
}

function ImageWithRetry({ src, alt, className, onClick }: { src: string, alt: string, className?: string, onClick?: (e: React.MouseEvent) => void }) {
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState(false);
    const [retryCount, setRetryCount] = useState(0);
    const imgRef = useRef<HTMLImageElement>(null);

    // Reset state when src changes
    useEffect(() => {
        setIsLoading(true);
        setError(false);
        setRetryCount(0);
    }, [src]);

    useEffect(() => {
        if (imgRef.current && imgRef.current.complete) {
            if (imgRef.current.naturalWidth > 0) {
                setIsLoading(false);
            }
        }
    }, [src]);

    useEffect(() => {
        if (error && retryCount < 10) {
            const timer = setTimeout(() => {
                setRetryCount(prev => prev + 1);
                setError(false);
            }, 1000 * (retryCount + 1)); // Exponential backoff
            return () => clearTimeout(timer);
        }
    }, [error, retryCount]);

    // Construct src with retry param to bypass cache if retrying
    const displaySrc = retryCount > 0 ? `${src}${src.includes('?') ? '&' : '?'}retry=${retryCount}` : src;

    return (
        <div className={`relative ${className}`}>
            {isLoading && (
                <div className="absolute inset-0 flex items-center justify-center bg-surface z-10">
                    <RefreshCw className="animate-spin text-text-secondary" size={24} />
                </div>
            )}
            <img
                ref={imgRef}
                src={displaySrc}
                alt={alt}
                className={`${className} ${isLoading ? 'opacity-50' : 'opacity-100'} transition-opacity duration-300`}
                onLoad={() => setIsLoading(false)}
                onError={() => {
                    setError(true);
                    setIsLoading(true); // Keep showing loader while retrying
                }}
                onClick={onClick}
            />
            {error && retryCount >= 10 && (
                <div className="absolute inset-0 flex flex-col items-center justify-center bg-red-500/10 backdrop-blur-sm z-20 p-2 text-center">
                    <span className="text-xs text-red-400 font-bold">Failed to load</span>
                    <span className="text-[0.625rem] text-red-400/70 break-all">{src}</span>
                </div>
            )}
        </div>
    );
}
