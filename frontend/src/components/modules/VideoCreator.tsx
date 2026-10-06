"use client";

import { useState, useEffect, useRef, useMemo } from "react";
import { useTranslations } from "next-intl";
import { motion, AnimatePresence } from "framer-motion";
import {
    Upload, X, Wand2, Plus, Loader2, Layout,
    Video,
    Eraser,
    Check,
    Image as ImageIcon,
    Film
} from "lucide-react";





import { useProjectStore } from "@/store/projectStore";
import { api, API_URL, VideoTask } from "@/lib/api";
import { I2V_MODE_AVAILABLE, R2V_SELECTION_MODEL_ID, VIDEO_R2V_MODELS, getModelReferenceImageLimit, isR2vImageBased } from "@/lib/modelCatalog";
import { selectedShotTiming, type ShotTiming } from "@/lib/shotDuration";
import { getAssetUrl, getAssetUrlWithTimestamp } from "@/lib/utils";
import { updateFrameSelection } from "@/lib/frameSelection";
import { deriveSegmentReferences } from "@/lib/segmentReferences";
import { toast } from "@/store/toastStore";
import PromptBuilder, { PromptSegment, PromptBuilderRef } from "./PromptBuilder";
import { scriptEditorApi } from '@/lib/scriptEditorApi';
import { H3_SKILL_ID, h3ParameterError, h3Images, h3ImageModeError } from '@/lib/h3PromptEnhancer';
import { useH3PromptEnhancement } from '@/hooks/useH3PromptEnhancement';
import H3EnhancementStatus from '@/components/shared/H3EnhancementStatus';
import type { VideoParams } from "@/store/projectStore";

type ReferenceAsset = {
    url: string;
    thumbnail: string;
    name: string;
    assetName: string;
    type: "角色" | "场景" | "道具" | "上传";
};

interface VideoCreatorProps {
    onTaskCreated: (project: any) => void;
    remixData: Partial<VideoTask> | null;
    onRemixClear: () => void;
    /** 队列里截下的一帧（还未上传）。传进来就自动传成参考图。 */
    extractedFrame?: { file: File; name: string } | null;
    onExtractedFrameClear?: () => void;
    params: VideoParams;
    onParamsChange: (params: Partial<VideoParams>) => void;
    onShotTimingChange: (timing: ShotTiming) => void;
}

// Motion 提示词生成已改成后端后台任务：3 秒轮询一次，最多等 10 分钟
//（上游 524 时后端会自动重试一次，所以单次等待可能接近 4 分钟）。
const MOTION_PROMPT_POLL_INTERVAL_MS = 3000;
const MOTION_PROMPT_POLL_TIMEOUT_MS = 10 * 60 * 1000;

// This gateway's Seedance channels require 720p; duration is validated against the catalog.
const requires720p = (modelId?: string | null) => (modelId || "").includes("seedance2.5");

export default function VideoCreator({ onTaskCreated, remixData, onRemixClear, extractedFrame, onExtractedFrameClear, params, onParamsChange, onShotTimingChange }: VideoCreatorProps) {
    const tc = useTranslations("creator");
    const currentProject = useProjectStore((state) => state.currentProject);
    const updateProject = useProjectStore((state) => state.updateProject);

    // Helper function to generate motion description text
    const getMotionDescription = () => {
        const parts: string[] = [];

        if (params.cameraMovement && params.cameraMovement !== 'none') {
            const cameraDescriptions: Record<string, string> = {
                'pan_left_slow': 'camera slowly pans to the left',
                'pan_right_slow': 'camera slowly pans to the right',
                'pan_left_fast': 'camera quickly pans to the left',
                'pan_right_fast': 'camera quickly pans to the right',
                'tilt_up': 'camera tilts up',
                'tilt_down': 'camera tilts down',
                'zoom_in_slow': 'camera slowly zooms in',
                'zoom_out_slow': 'camera slowly zooms out',
                'zoom_in_fast': 'camera dramatically zooms in',
                'zoom_out_fast': 'camera dramatically zooms out',
                'dolly_in': 'camera dolly in',
                'dolly_out': 'camera dolly out',
                'orbit_left': 'camera orbits to the left',
                'orbit_right': 'camera orbits to the right',
                'crane_up': 'camera cranes up',
                'crane_down': 'camera cranes down'
            };
            parts.push(cameraDescriptions[params.cameraMovement] || '');
        }

        if (params.subjectMotion && params.subjectMotion !== 'still') {
            const subjectDescriptions: Record<string, string> = {
                'subtle': 'subtle movement',
                'natural': 'natural movement',
                'dynamic': 'dynamic action',
                'fast': 'fast-paced action'
            };
            parts.push(subjectDescriptions[params.subjectMotion] || '');
        }

        return parts.filter(p => p).join(', ');
    };

    const [selectedImages, setSelectedImages] = useState<string[]>([]);
    const [uploadingPaths, setUploadingPaths] = useState<Record<string, string>>({}); // Map blobUrl -> serverUrl
    const [activeTab, setActiveTab] = useState<"storyboard" | "upload">("storyboard");

    const [referenceAssets, setReferenceAssets] = useState<ReferenceAsset[]>([]);
    const [selectedFrameIds, setSelectedFrameIds] = useState<string[]>([]);
    const [frameSelectionAnchor, setFrameSelectionAnchor] = useState<string | null>(null);
    const [isGeneratingPrompt, setIsGeneratingPrompt] = useState(false);
    const [promptJobStatus, setPromptJobStatus] = useState<"" | "queued" | "running">("");
    const [motionError, setMotionError] = useState("");
    // 卸载后停止轮询，避免离开页面还在刷接口
    const unmountedRef = useRef(false);
    // 必须重置为 false：dev 的 React StrictMode 会 mount → cleanup → mount，
    // 少了这行 ref 会永久停在 true，轮询直接被 while 条件跳过
    // （表现：点「生成提示词」没反应，但后端任务其实跑完了、结果没人取）。
    useEffect(() => {
        unmountedRef.current = false;
        return () => { unmountedRef.current = true; };
    }, []);
    const [selectedPromptPreset, setSelectedPromptPreset] = useState<string>("r2v");
    const [h3SkillAvailable, setH3SkillAvailable] = useState(false);
    useEffect(() => {
        let cancelled = false;
        const refresh = () => { void scriptEditorApi.listScriptSkills('motion').then((items) => {
            if (cancelled) return;
            const available = items.some((item) => item.id === H3_SKILL_ID && !item.hidden);
            setH3SkillAvailable(available);
            if (!available) setSelectedPromptPreset((preset) => preset === H3_SKILL_ID ? 'r2v' : preset);
        }).catch(() => { if (!cancelled) setMotionError('增强 Skill 加载失败，可刷新后重试。'); }); };
        refresh(); window.addEventListener('script-skills-changed', refresh);
        return () => { cancelled = true; window.removeEventListener('script-skills-changed', refresh); };
    }, []);
    const [isUploadingReference, setIsUploadingReference] = useState(false);
    const [generationMode, setGenerationMode] = useState<"i2v" | "r2v">(I2V_MODE_AVAILABLE ? "i2v" : "r2v"); // Local mode state
    const [extractingFrameId, setExtractingFrameId] = useState<string | null>(null);
    const shotTiming = useMemo(() => selectedShotTiming(currentProject?.frames || [], selectedFrameIds), [currentProject?.frames, selectedFrameIds]);
    const outputDuration = generationMode === 'r2v' ? shotTiming.duration : params.duration;
    const durationConfig = VIDEO_R2V_MODELS.find(model => model.id === params.model)?.duration;
    let durationError = '';
    if (generationMode === 'r2v' && shotTiming.count) {
        if (shotTiming.missingCount) durationError = `${shotTiming.missingCount} 个镜头缺少有效时长，请先在分镜中补齐`;
        else if (outputDuration && durationConfig) {
            if (durationConfig.type === 'slider' && (outputDuration < durationConfig.min || outputDuration > durationConfig.max))
                durationError = `所选镜头共 ${outputDuration} 秒，当前模型支持 ${durationConfig.min}–${durationConfig.max} 秒，请缩小镜头范围或更换模型`;
            else if (durationConfig.type === 'fixed' && outputDuration !== durationConfig.value)
                durationError = `所选镜头共 ${outputDuration} 秒，当前模型仅支持 ${durationConfig.value} 秒，请调整镜头选择或更换模型`;
            else if (durationConfig.type === 'buttons' && !durationConfig.options.includes(outputDuration))
                durationError = `所选镜头共 ${outputDuration} 秒，当前模型支持 ${durationConfig.options.join('、')} 秒，请调整镜头选择或更换模型`;
        }
    }
    useEffect(() => { onShotTimingChange(shotTiming); }, [shotTiming, onShotTimingChange]);
    useEffect(() => {
        setSelectedFrameIds([]);
        setFrameSelectionAnchor(null);
    }, [currentProject?.id]);

    // Sync from parent params
    useEffect(() => {
        // 没有可用的 I2V 模型时（本安装只接重子网关）强制停在参考图驱动，
        // 否则会拿着没配密钥的 i2v 模型去生成。
        if (!I2V_MODE_AVAILABLE) {
            setGenerationMode("r2v");
            return;
        }
        if (params.generationMode) {
            setGenerationMode(params.generationMode as "i2v" | "r2v");
        }
    }, [params.generationMode]);


    const handleExtractLastFrame = async (frameId: string, e: React.MouseEvent) => {
        e.stopPropagation();
        if (!currentProject?.frames) return;

        const frameIndex = currentProject.frames.findIndex((f: any) => f.id === frameId);
        if (frameIndex <= 0) return;

        const prevFrame = currentProject.frames[frameIndex - 1];
        if (!prevFrame.selected_video_id) return;

        const prevVideo = currentProject.video_tasks?.find(
            (t: any) => t.id === prevFrame.selected_video_id && t.status === "completed"
        );
        if (!prevVideo) return;

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

    const handleFrameSelect = (frame: any) => {
        // Prefer rendered_image_url (from extracted last frame / uploaded image), fallback to image_url
        const url = frame.rendered_image_url || frame.image_url;
        if (!url) return;

        // If already selected, deselect
        if (selectedImages.includes(url)) {
            setSelectedImages([]);
            return;
        }

        // Select new image (replace existing)
        setSelectedImages([url]);

        // Auto-fill prompt (Replace existing prompt)
        let newPrompt = frame.image_prompt || frame.action_description || "";
        if (frame.dialogue) {
            newPrompt += ` . Dialogue: ${frame.dialogue}`;
        }
        setSegments([{ type: "text", value: newPrompt, id: "init" }]);
    };
    const [segments, setSegments] = useState<PromptSegment[]>([{ type: "text", value: "", id: "init" }]);
    const promptBuilderRef = useRef<PromptBuilderRef>(null);

    // Computed prompt for API
    const prompt = segments.map(s => s.value).join(" ");
    const h3 = useH3PromptEnhancement(`motion:${currentProject?.id ?? ''}`);
    const isH3PromptSkill = selectedPromptPreset === H3_SKILL_ID;
    const h3Ratio = currentProject?.model_settings?.storyboard_aspect_ratio || "16:9";
    const h3Invalid = h3ParameterError(shotTiming.duration, h3Ratio) || h3ImageModeError(referenceAssets.length, 'reference');
    const h3SourceContext = JSON.stringify({
        projectId: currentProject?.id, prompt, segments, frameIds: selectedFrameIds,
        frames: currentProject?.frames?.filter((frame: any) => selectedFrameIds.includes(frame.id)),
        references: referenceAssets, duration: shotTiming.duration, ratio: h3Ratio, model: params.model,
    });
    const h3SourceRef = useRef(h3SourceContext);
    h3SourceRef.current = h3SourceContext;
    const h3PreparationLock = useRef(false);
    const [h3Original, setH3Original] = useState<{ segments: PromptSegment[]; appliedText: string } | null>(null);
    useEffect(() => { setH3Original(null); }, [currentProject?.id]);
    const adoptH3Prompt = () => {
        if (!h3.job || h3.job.status !== 'completed') return;
        if (h3.job.source_context !== h3SourceRef.current) { setMotionError('原文、镜头或参数已变化，不能覆盖新编辑。可复制增强结果后重新处理。'); return; }
        if (h3.job.text.length > 12000) { setMotionError('增强结果超过当前视频提示词的 12000 字上限，请复制后精简，未截断结果。'); return; }
        setH3Original({ segments, appliedText: h3.job.text });
        setSegments([{ type: 'text', value: h3.job.text, id: `h3-${h3.job.job_id}` }]);
        setMotionError('');
        h3.clear();
    };

    // negativePrompt moved to params
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [submitSuccess, setSubmitSuccess] = useState(false);
    const [showCameraDropdown, setShowCameraDropdown] = useState(false);
    const [polishedPrompt, setPolishedPrompt] = useState<{ cn: string; en: string } | null>(null);
    const [isPolishing, setIsPolishing] = useState(false);
    const [feedbackText, setFeedbackText] = useState("");

    const handlePolish = async (feedback: string = "") => {
        const draftPrompt = feedback ? (polishedPrompt?.en || prompt) : prompt;
        if (!draftPrompt) return;
        setIsPolishing(true);
        try {
            let res;
            const scriptId = currentProject?.id || "";
            if (generationMode === 'r2v') {
                // R2V mode: use R2V-specific polish with slot info
                const slotInfo = referenceAssets.map((asset) => ({ description: `${asset.type}：${asset.name}` }));
                res = await api.polishR2VPrompt(draftPrompt, slotInfo, feedback, scriptId, "", referenceAssets.map((asset) => asset.url));
            } else {
                // I2V mode: use video polish
                res = await api.polishVideoPrompt(draftPrompt, feedback, scriptId);
            }
            if (res.prompt_cn && res.prompt_en) {
                setPolishedPrompt({ cn: res.prompt_cn, en: res.prompt_en });
                setFeedbackText("");
            }
        } catch (error) {
            console.error("Polish failed", error);
            alert(tc("aiPolishFailed"));
        } finally {
            setIsPolishing(false);
        }
    };


    // Handle Remix Data
    useEffect(() => {
        if (remixData) {
            if (remixData.image_url) setSelectedImages([remixData.image_url]);
            if (remixData.prompt) setSegments([{ type: "text", value: remixData.prompt, id: "remix" }]);
            // negativePrompt handled by parent

            // Clear remix data after applying to avoid re-applying on every render
            onRemixClear();
        }
    }, [remixData, onRemixClear]);

    const handleImageSelect = (files: FileList | null) => {
        if (!files) return;

        const newImages: string[] = [];

        Array.from(files).forEach(async (file) => {
            const blobUrl = URL.createObjectURL(file);
            newImages.push(blobUrl);

            // Background Upload
            try {
                const res = await api.uploadFile(file);
                setUploadingPaths(prev => ({ ...prev, [blobUrl]: res.url }));
            } catch (error) {
                console.error("Upload failed", error);
                // Could remove from selectedImages or show error state on the specific image
            }
        });

        setSelectedImages(prev => [...prev, ...newImages]);
    };

    const handleAssetSelect = (url: string) => {
        if (!selectedImages.includes(url)) {
            setSelectedImages(prev => [...prev, url]);
        }
    };

    const removeImage = (index: number) => {
        setSelectedImages(prev => prev.filter((_, i) => i !== index));
    };

    const handleR2VFrameSelect = (frame: any) => {
        const frames = currentProject?.frames || [];
        const next = updateFrameSelection(
            frames.map((item: any) => item.id),
            selectedFrameIds,
            frameSelectionAnchor,
            frame.id,
        );
        setSelectedFrameIds(next.selectedIds);
        setFrameSelectionAnchor(next.anchorId);
    };

    const addReference = (asset: ReferenceAsset) => {
        setMotionError("");
        setReferenceAssets((items) => {
            if (items.some((item) => item.url === asset.url)) return items;
            if (items.length >= referenceImageLimit) {
                setMotionError(`最多选择 ${referenceImageLimit} 张参考图`);
                return items;
            }
            return [...items, asset];
        });
    };

    const uploadReferences = async (files: FileList | null) => {
        if (!files) return;
        const remaining = referenceImageLimit - referenceAssets.length;
        if (remaining <= 0) return setMotionError(`最多选择 ${referenceImageLimit} 张参考图`);
        setIsUploadingReference(true);
        try {
            for (const file of Array.from(files).slice(0, remaining)) {
                const uploaded = await api.uploadFile(file);
                addReference({ url: uploaded.url, thumbnail: getAssetUrl(uploaded.url), name: file.name, assetName: file.name, type: "上传" });
            }
        } catch (error: any) {
            setMotionError(error?.response?.data?.detail || "参考图上传失败");
        } finally {
            setIsUploadingReference(false);
        }
    };

    const generateMotionPrompt = async () => {
        if (!currentProject || !selectedFrameIds.length) return;
        if (shotTiming.duration === null) { setMotionError('请先补齐所选镜头时长'); return; }
        const scriptId = currentProject.id;
        if (isH3PromptSkill) {
            if (h3.busy || h3.pendingId || h3PreparationLock.current) return;
            if (h3Invalid) { setMotionError(h3Invalid); return; }
            const sourceContext = h3SourceRef.current;
            h3PreparationLock.current = true;
            setIsGeneratingPrompt(true); setMotionError('');
            try {
                // Empty draft: assemble selected shots locally, without an extra LLM call.
                const text = prompt.trim() ? prompt : (await api.assembleMotionPrompt(scriptId, {
                    frame_ids: selectedFrameIds,
                    references: referenceAssets.map((asset) => ({ name: asset.name, asset_type: asset.type })),
                    ratio: h3Ratio, duration: shotTiming.duration,
                })).prompt;
                if (unmountedRef.current || sourceContext !== h3SourceRef.current) return;
                h3.run({ text, images: h3Images(referenceAssets.map((asset) => ({ ref: asset.url, name: asset.name }))), duration: shotTiming.duration, ratio: h3Ratio, source_context: sourceContext });
            } catch (reason: any) {
                if (!unmountedRef.current && sourceContext === h3SourceRef.current) setMotionError(reason?.response?.data?.detail || '准备增强提示词失败');
            } finally { h3PreparationLock.current = false; if (!unmountedRef.current) setIsGeneratingPrompt(false); }
            return;
        }
        setIsGeneratingPrompt(true);
        setMotionError("");
        setPromptJobStatus("queued");
        try {
            const job = await api.generateMotionPrompt(scriptId, {
                frame_ids: selectedFrameIds,
                references: referenceAssets.map((asset) => ({ name: asset.name, asset_type: asset.type })),
                prompt_preset: selectedPromptPreset === "r2v_minimax" ? "r2v_minimax" : "r2v",
                duration: shotTiming.duration,
                ratio: currentProject.model_settings?.storyboard_aspect_ratio || "16:9",
            });
            // 后端已改成后台任务（一次生成可能 2 分钟，上游会 524），这里轮询拿结果。
            const deadline = Date.now() + MOTION_PROMPT_POLL_TIMEOUT_MS;
            while (Date.now() < deadline && !unmountedRef.current) {
                await new Promise((resolve) => setTimeout(resolve, MOTION_PROMPT_POLL_INTERVAL_MS));
                const state = await api.getMotionPromptJob(scriptId, job.job_id);
                if (state.status === "done") {
                    setSegments([{ type: "text", value: state.prompt, id: `motion-${Date.now()}` }]);
                    return;
                }
                if (state.status === "failed") {
                    setMotionError(state.error || "生成提示词失败");
                    return;
                }
                setPromptJobStatus(state.status);
            }
            if (!unmountedRef.current) setMotionError("生成超时：后台可能仍在处理，稍后可重试");
        } catch (error: any) {
            setMotionError(error?.response?.data?.detail || "生成提示词失败");
        } finally {
            setIsGeneratingPrompt(false);
            setPromptJobStatus("");
        }
    };

    /** 本地拼装：不调 AI，直接按序号拼「参考图N + 镜头N」，秒出且不会失败。 */
    const assembleMotionPrompt = async () => {
        if (!currentProject || !selectedFrameIds.length) return;
        if (shotTiming.duration === null) { setMotionError('请先补齐所选镜头时长'); return; }
        setMotionError("");
        try {
            const result = await api.assembleMotionPrompt(currentProject.id, {
                frame_ids: selectedFrameIds,
                references: referenceAssets.map((asset) => ({ name: asset.name, asset_type: asset.type })),
                ratio: currentProject.model_settings?.storyboard_aspect_ratio || "16:9",
                duration: shotTiming.duration,
            });
            setSegments([{ type: "text", value: result.prompt, id: `motion-${Date.now()}` }]);
        } catch (error: any) {
            setMotionError(error?.response?.data?.detail || "拼装提示词失败");
        }
    };

    const handleSubmit = async () => {
        if (durationError || !outputDuration) { setMotionError(durationError || '请先选择镜头并补齐时长'); return; }
        // Validation based on mode
        if (generationMode === 'i2v') {
            if (selectedImages.length === 0 || !prompt || !currentProject) return;
        } else {
            if (!referenceAssets.length || !selectedFrameIds.length) {
                setMotionError("请先选择连续镜头和至少一张参考图");
                return;
            }
            if (!prompt || !currentProject || prompt.length > 12000) {
                setMotionError("视频提示词必须为 1-12000 字");
                return;
            }
        }

        setIsSubmitting(true);
        try {
            // Add motion description to prompt
            const motionDesc = getMotionDescription();
            const finalPrompt = motionDesc ? `${prompt}, ${motionDesc}` : prompt;

            // Optimistic update - add pending tasks to queue immediately
            const optimisticTasks: VideoTask[] = [];

            // Determine items to process
            // In I2V: process selected images
            // In R2V: process selected images OR a single task if no image selected
            const itemsToProcess = generationMode === 'r2v' ? [""] : selectedImages;

            itemsToProcess.forEach((img, idx) => {
                let displayUrl = img;
                if (img && img.startsWith("blob:")) {
                    displayUrl = uploadingPaths[img] || img;
                } else if (img && !img.startsWith("http")) {
                    displayUrl = img;
                }

                // Determine model based on generation mode
                const actualModel = params.model;
                const r2vImageBased = generationMode === 'r2v' && isR2vImageBased(actualModel);
                const referenceVideos = generationMode === 'r2v' && !r2vImageBased
                    ? []
                    : undefined;

                // Create batch_size tasks for each image
                for (let i = 0; i < params.batchSize; i++) {
                    optimisticTasks.push({
                        id: `temp-${Date.now()}-${idx}-${i}`,
                        project_id: currentProject.id,
                        image_url: displayUrl, // Might be empty string for R2V
                        prompt: finalPrompt,
                        status: "pending",
                        video_url: undefined,
                        duration: outputDuration,
                        seed: params.seed,
                        resolution: params.resolution,
                        generate_audio: params.generateAudio,
                        audio_url: params.audioUrl,
                        prompt_extend: params.promptExtend,
                        negative_prompt: params.negativePrompt,
                        model: actualModel,
                        created_at: Date.now() / 1000,
                        generation_mode: generationMode,
                        reference_video_urls: referenceVideos,
                        reference_image_urls: r2vImageBased
                            ? referenceAssets.map((asset) => asset.url)
                            : undefined,
                        source_frame_ids: generationMode === 'r2v' ? selectedFrameIds : [],
                        skill_id: undefined,
                        skill_name: generationMode === 'r2v' ? "提示词配置 · R2V" : undefined,
                    });
                }
            });

            // Immediately update UI with optimistic tasks
            const optimisticProject = {
                ...currentProject,
                video_tasks: [...(currentProject.video_tasks || []), ...optimisticTasks]
            };
            onTaskCreated(optimisticProject);

            // Batch submit for all images
            for (const img of itemsToProcess) {
                let finalImageUrl = img;
                if (img && img.startsWith("blob:")) {
                    if (uploadingPaths[img]) {
                        finalImageUrl = uploadingPaths[img];
                    } else {
                        console.warn("Image upload pending for", img);
                        continue;
                    }
                } else if (img && img.startsWith(`${API_URL}/files/`)) {
                    finalImageUrl = img.replace(`${API_URL}/files/`, "");
                }

                // Find frame ID - use selectedFrameId directly for R2V mode
                let frameId: string | undefined;
                if (generationMode === 'r2v') {
                    frameId = selectedFrameIds[0];
                } else {
                    // I2V mode: find frame by matching image URL (check rendered_image_url first, then image_url)
                    const frame = currentProject?.frames?.find((f: any) =>
                        (f.rendered_image_url || f.image_url) === img ||
                        f.image_url === img ||
                        `${API_URL}/files/${f.image_url}` === img
                    );
                    frameId = frame ? frame.id : undefined;
                }

                // Determine model based on generation mode
                // R2V mode uses the hidden route model, I2V uses the selected visible model.
                const actualModel = params.model;
                const r2vImageBased = generationMode === 'r2v' && isR2vImageBased(actualModel);

                // Get reference URLs from cast slots for R2V
                const referenceVideos = generationMode === 'r2v' && !r2vImageBased
                    ? []
                    : [];
                const referenceImages = r2vImageBased
                    ? referenceAssets.map((asset) => asset.url)
                    : [];

                await api.createVideoTask(
                    currentProject.id,
                    finalImageUrl, // Can be empty string
                    finalPrompt,
                    outputDuration,
                    params.seed,
                    params.resolution,
                    params.generateAudio,
                    params.audioUrl,
                    params.promptExtend,
                    params.negativePrompt,
                    params.batchSize,
                    actualModel,  // Use computed model
                    frameId,
                    params.shotType,
                    generationMode,  // Use local state
                    referenceVideos,  // Use cast slots (Wan R2V)
                    // Kling params
                    params.mode,
                    params.sound,
                    params.cfgScale,
                    // Vidu params
                    params.viduAudio,
                    params.movementAmplitude,
                    // HappyHorse params
                    referenceImages,
                    generationMode === 'r2v' ? (currentProject.model_settings?.storyboard_aspect_ratio || "16:9") : undefined,
                    undefined,
                    undefined,
                    generationMode === 'r2v' ? selectedFrameIds : []
                );
            }

            // Refresh with actual data from server
            const updatedProject = await api.getProject(currentProject.id);
            onTaskCreated(updatedProject);

            // Success feedback
            setSubmitSuccess(true);
            setTimeout(() => setSubmitSuccess(false), 1500);

            // Clear selection after successful submit
            // setSelectedImages([]); // Keep selection for iterative generation
        } catch (error: any) {
            console.error("Failed to submit task:", error);
            const detail = error?.response?.data?.detail || tc("submitFailed");
            if (generationMode === "r2v") setMotionError(detail);
            else alert(detail);
            // Refresh to remove optimistic updates
            const updatedProject = await api.getProject(currentProject.id);
            onTaskCreated(updatedProject);
        } finally {
            setIsSubmitting(false);
        }
    };

    // Keyboard shortcut
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.ctrlKey && e.key === "Enter") {
                handleSubmit();
            }
        };
        window.addEventListener("keydown", handleKeyDown);
        return () => window.removeEventListener("keydown", handleKeyDown);
    }, [selectedImages, prompt, currentProject, params, referenceAssets, selectedFrameIds, generationMode, outputDuration, durationError]);

    // Available assets for drag/drop or selection
    const availableAssets = currentProject ? [
        ...currentProject.characters.map((c: any) => ({
            url: getAssetUrl(c.image_url),
            title: c.name
        })),
        ...currentProject.scenes.map((s: any) => ({
            url: getAssetUrl(s.image_url),
            title: s.name
        }))
    ].filter(a => a.url) : [];

    const selectedAssetUrl = (asset: any) => {
        const unit = asset.reference_sheet || asset.image_asset || asset.full_body;
        const selectedId = unit?.selected_image_id || unit?.selected_id;
        const variants = unit?.image_variants || unit?.variants || [];
        const raw = variants.find((item: any) => item.id === selectedId)?.url
            || asset.image_url
            || asset.full_body_image_url
            || variants[0]?.url
            || "";
        // Backend files are served relative to output/; remove the legacy
        // output/ prefix so both preview and provider upload resolve correctly.
        return raw.startsWith("output/") ? raw.slice("output/".length) : raw;
    };

    const availableReferenceImages: ReferenceAsset[] = currentProject ? [
        ...currentProject.characters.map((asset: any) => ({ asset, type: "角色" as const })),
        ...currentProject.scenes.map((asset: any) => ({ asset, type: "场景" as const })),
        ...currentProject.props.map((asset: any) => ({ asset, type: "道具" as const })),
    ].map(({ asset, type }) => {
        const url = selectedAssetUrl(asset);
        return { url, thumbnail: getAssetUrl(url), name: asset.name, assetName: asset.name, type };
    }).filter((asset) => asset.url && asset.url !== "null" && asset.url !== "undefined") : [];

    const castSlots = referenceAssets;
    const availableReferenceVideos: any[] = [];
    const r2vUsesImages = true;
    const referenceImageLimit = getModelReferenceImageLimit(params.model);
    const promptLimit = 12000;

    // 截帧 → 上传 → 插到参考图**第一位**。
    //
    // 插第一位而不是末尾：参考图是按选择顺序提交的，而下一段最需要的就是「上一段
    // 结尾的位置关系」，那张应该当主参考。连续截几帧时，最新的永远在最前面。
    //
    // 这里必须写在 referenceImageLimit 之后：依赖数组在渲染期求值，写在它前面会
    // 撞上 const 的 TDZ。
    useEffect(() => {
        if (!extractedFrame) return;
        let cancelled = false;
        (async () => {
            try {
                if (referenceAssets.length >= referenceImageLimit) {
                    setMotionError(tc("refImagesFull", { limit: referenceImageLimit }));
                    return;
                }
                const { url } = await api.uploadFile(extractedFrame.file);
                if (cancelled) return;
                setReferenceAssets((items) =>
                    items.length >= referenceImageLimit
                        ? items
                        : [{
                            url,
                            thumbnail: url,
                            name: extractedFrame.name,
                            assetName: extractedFrame.name,
                            type: "上传" as const,
                        }, ...items]
                );
            } catch {
                if (!cancelled) setMotionError(tc("frameExtractUploadFailed"));
            } finally {
                if (!cancelled) onExtractedFrameClear?.();
            }
        })();
        return () => { cancelled = true; };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [extractedFrame, onExtractedFrameClear, referenceImageLimit]);
    const handleCastSlotSelect = (_slotIndex: number, selected: { url: string; name: string }) => {
        const asset = availableReferenceImages.find((item) => item.url === selected.url);
        if (asset) addReference(asset);
    };
    const handleClearCastSlot = (slotIndex: number) => setReferenceAssets((items) => items.filter((_, index) => index !== slotIndex));

    /**
     * 从选中的连续镜头推导参考图，**只填槽位**（不碰提示词——用户可能已经手改过）。
     *
     * 保留并追加：手动上传的图、手动加的资产都留着，只补还没有的（按 URL 去重）。
     * 超 9 张不截断：计数会标红，用户自己删镜头或删槽位。
     */
    const handleAutoBindReferences = () => {
        setMotionError("");
        if (!currentProject || !selectedFrameIds.length) return;

        const { references, misses } = deriveSegmentReferences(
            selectedFrameIds,
            (currentProject.frames || []) as any,
            { characters: currentProject.characters, scenes: currentProject.scenes, props: currentProject.props },
        );

        const have = new Set(referenceAssets.map((item) => item.url));
        const added = references.filter((item) => !have.has(item.url));
        if (added.length) setReferenceAssets((items) => [...items, ...added.filter((item) => !items.some((i) => i.url === item.url))]);

        const noImage = misses.filter((item) => item.reason === "no-image");
        const missing = misses.filter((item) => item.reason === "missing-asset");
        const notBindable = [...noImage, ...missing].map((item) => `${item.name}（${item.type}·第${item.shot}镜）`);

        if (!references.length && !notBindable.length) {
            toast.warning(tc("autoBindNothing"), { body: tc("autoBindNothingBody") });
            return;
        }
        if (!added.length) {
            toast.info(tc("autoBindNoChange"), { body: tc("autoBindNoChangeBody") });
            return;
        }

        const total = referenceAssets.length + added.length;
        const over = total > referenceImageLimit ? tc("autoBindOverLimit", { total, limit: referenceImageLimit }) : "";
        if (notBindable.length) {
            toast.warning(tc("autoBindPartial", { count: added.length }), { body: `${tc("autoBindNotBindable")}${notBindable.join("、")}${over}` });
        } else {
            toast.success(tc("autoBindDone", { count: added.length }), { body: over });
        }
    };

    return (
        <div className="h-full flex flex-col relative min-h-0">
            {/* Scrollable Content Area */}
            <div className="flex-1 overflow-y-auto p-8 custom-scrollbar min-h-0">
                <h2 className="text-2xl font-display font-bold text-foreground mb-6 flex items-center gap-3">
                    <div className="w-2 h-8 bg-primary rounded-full" />
                    {tc("title")}
                    <span className="text-xs font-mono text-text-muted bg-glass px-2 py-1 rounded">Motion</span>
                </h2>

                <div className="flex flex-col gap-6 max-w-4xl mx-auto w-full pb-8">
                    {/* Generation Mode Switcher（本安装只接重子，没有 i2v 模型时不显示） */}
                    {I2V_MODE_AVAILABLE && (
                    <div className="flex items-center justify-center">
                        <div className="flex bg-surface rounded-xl p-1.5 gap-1 border border-glass-border">
                            <button
                                onClick={() => {
                                    setGenerationMode("i2v");
                                    onParamsChange({
                                        generationMode: "i2v",
                                        model: currentProject?.model_settings?.i2v_model || params.model,
                                    });
                                }}
                                className={`px-5 py-2.5 text-sm rounded-lg flex items-center gap-2 transition-all font-medium ${generationMode === "i2v"
                                    ? "bg-primary text-foreground shadow-lg"
                                    : "text-text-secondary hover:text-foreground hover:bg-glass"
                                    }`}
                            >
                                <ImageIcon size={16} />
                                {tc("i2vMode")}
                            </button>
                            <button
                                onClick={() => {
                                    const configuredR2vModel = currentProject?.model_settings?.r2v_model || R2V_SELECTION_MODEL_ID;
                                    const referenceImageModel = isR2vImageBased(configuredR2vModel) ? configuredR2vModel : R2V_SELECTION_MODEL_ID;
                                    setGenerationMode("r2v");
                                    onParamsChange({
                                        generationMode: "r2v",
                                        model: referenceImageModel,
                                        resolution: requires720p(referenceImageModel) ? "720p" : params.resolution,
                                    });
                                }}
                                className={`px-5 py-2.5 text-sm rounded-lg flex items-center gap-2 transition-all font-medium ${generationMode === "r2v"
                                    ? "bg-primary text-foreground shadow-lg"
                                    : "text-text-secondary hover:text-foreground hover:bg-glass"
                                    }`}
                            >
                                <Film size={16} />
                                {tc("r2vMode")}
                            </button>
                        </div>
                    </div>
                    )}
                    {/* === I2V MODE: Source Selector === */}
                    {generationMode === 'i2v' && (
                        <div className="space-y-4">
                            <div className="flex items-center justify-between">
                                <label className="text-sm font-medium text-text-secondary">{tc("firstFrame")}</label>
                                <div className="flex bg-glass rounded-lg p-1 gap-1">
                                    <button
                                        onClick={() => setActiveTab("storyboard")}
                                        className={`px-3 py-1.5 text-xs rounded-md flex items-center gap-2 transition-all ${activeTab === "storyboard"
                                            ? "bg-primary text-foreground shadow-sm"
                                            : "text-text-secondary hover:text-foreground hover:bg-glass"
                                            }`}
                                    >
                                        <Layout size={14} /> {tc("storyboardSource")}
                                    </button>
                                    <button
                                        onClick={() => setActiveTab("upload")}
                                        className={`px-3 py-1.5 text-xs rounded-md flex items-center gap-2 transition-all ${activeTab === "upload"
                                            ? "bg-primary text-foreground shadow-sm"
                                            : "text-text-secondary hover:text-foreground hover:bg-glass"
                                            }`}
                                    >
                                        <Upload size={14} /> {tc("uploadSource")}
                                    </button>
                                </div>
                            </div>

                            {/* Tab Content */}
                            <div className="bg-surface border border-glass-border rounded-xl p-4 min-h-[200px]">
                                {activeTab === "storyboard" ? (
                                    <div className="space-y-4">
                                        {currentProject?.frames && currentProject.frames.length > 0 ? (() => {
                                            const completedVideoIds = new Set(
                                                currentProject.video_tasks
                                                    ?.filter((t: any) => t.status === "completed")
                                                    .map((t: any) => t.id) ?? []
                                            );
                                            return (
                                            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6 max-h-[500px] overflow-y-auto custom-scrollbar pr-2 p-2">
                                                {currentProject.frames.map((frame: any, index: number) => {
                                                    const prevFrame = index > 0 ? currentProject.frames![index - 1] : null;
                                                    const prevVideoCompleted = prevFrame?.selected_video_id && completedVideoIds.has(prevFrame.selected_video_id);
                                                    const isExtracting = extractingFrameId === frame.id;
                                                    const hasExtracted = !!frame.rendered_image_url;

                                                    return (
                                                    <div
                                                        key={frame.id}
                                                        onClick={() => handleFrameSelect(frame)}
                                                        className={`group relative aspect-video rounded-lg overflow-hidden border cursor-pointer transition-all ${selectedImages.includes(frame.rendered_image_url || frame.image_url)
                                                            ? "border-primary ring-2 ring-primary/50"
                                                            : "border-glass-border hover:border-glass-border"
                                                            }`}
                                                    >
                                                        {(frame.rendered_image_url || frame.image_url) ? (
                                                            <img
                                                                src={getAssetUrlWithTimestamp(frame.rendered_image_url || frame.image_url, frame.updated_at)}
                                                                alt={`Frame ${frame.id}`}
                                                                className="w-full h-full object-cover"
                                                            />
                                                        ) : (
                                                            <div className="w-full h-full bg-glass flex items-center justify-center text-xs text-text-muted">
                                                                No Image
                                                            </div>
                                                        )}
                                                        <div className="absolute inset-0 bg-overlay opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                                                            <span className="text-xs text-foreground font-bold">Select</span>
                                                        </div>
                                                        {/* Frame Number Badge */}
                                                        <div className="absolute top-1 left-1 bg-surface px-1.5 rounded text-[0.625rem] text-text-secondary backdrop-blur-sm">
                                                            #{frame.id.slice(0, 4)}
                                                        </div>
                                                        {/* Extract Last Frame Button */}
                                                        {prevVideoCompleted && (
                                                            <button
                                                                onClick={(e) => handleExtractLastFrame(frame.id, e)}
                                                                disabled={isExtracting}
                                                                className={`absolute bottom-1 right-1 flex items-center gap-1 px-1.5 py-0.5 rounded text-[0.625rem] font-medium backdrop-blur-sm transition-colors ${
                                                                    hasExtracted
                                                                        ? "bg-green-500/20 text-green-400 border border-green-500/30 hover:bg-primary/20 hover:text-primary hover:border-primary/30"
                                                                        : "bg-primary/20 text-primary border border-primary/30 hover:bg-primary/40"
                                                                } disabled:opacity-50`}
                                                                title={hasExtracted ? "Re-extract previous video's last frame" : "Use previous video's last frame as input"}
                                                            >
                                                                {isExtracting ? (
                                                                    <Loader2 size={10} className="animate-spin" />
                                                                ) : hasExtracted ? (
                                                                    <><Check size={10} /> Applied</>
                                                                ) : (
                                                                    <><Film size={10} /> Prev End Frame</>
                                                                )}
                                                            </button>
                                                        )}
                                                    </div>
                                                    );
                                                })}
                                            </div>
                                            );
                                        })() : (
                                            <div className="flex flex-col items-center justify-center h-[200px] text-text-muted gap-2">
                                                <Layout size={32} className="opacity-20" />
                                                <p className="text-xs">No storyboard frames found.</p>
                                            </div>
                                        )}

                                        {/* Selected Preview (Storyboard Mode) */}
                                        {selectedImages.length > 0 && (
                                            <div className="pt-4 border-t border-glass-border">
                                                <p className="text-xs text-text-muted mb-2">Selected for Generation:</p>
                                                <div className="flex gap-2 flex-wrap">
                                                    {selectedImages.map((img, idx) => {
                                                        // Find frame to get updated_at for cache busting
                                                        const frame = currentProject?.frames?.find((f: any) => (f.rendered_image_url || f.image_url) === img);
                                                        const timestamp = frame?.updated_at || 0;
                                                        return (
                                                            <div key={idx} className="relative w-24 aspect-video rounded-lg overflow-hidden border border-glass-border">
                                                                <img
                                                                    src={timestamp ? getAssetUrlWithTimestamp(img, timestamp) : getAssetUrl(img)}
                                                                    alt="Selected"
                                                                    className="w-full h-full object-cover"
                                                                />
                                                                <button
                                                                    onClick={() => removeImage(idx)}
                                                                    className="absolute top-1 right-1 p-0.5 bg-surface rounded-full text-foreground hover:bg-red-500"
                                                                >
                                                                    <X size={10} />
                                                                </button>
                                                            </div>
                                                        );
                                                    })}
                                                </div>
                                            </div>
                                        )}
                                    </div>
                                ) : (
                                    /* Upload Mode Content */
                                    <div className="space-y-4">
                                        <div className="grid grid-cols-3 gap-4">
                                            {selectedImages.map((img, idx) => (
                                                <div key={idx} className="relative aspect-video bg-surface rounded-xl overflow-hidden border border-glass-border group">
                                                    <img
                                                        src={getAssetUrl(img)}
                                                        alt={`Input ${idx}`}
                                                        className="w-full h-full object-contain"
                                                    />
                                                    <button
                                                        onClick={() => removeImage(idx)}
                                                        className="absolute top-2 right-2 p-1 bg-surface rounded-full text-foreground opacity-0 group-hover:opacity-100 transition-opacity hover:bg-red-500"
                                                    >
                                                        <X size={12} />
                                                    </button>
                                                    {img.startsWith("blob:") && !uploadingPaths[img] && (
                                                        <div className="absolute inset-0 flex items-center justify-center bg-overlay">
                                                            <Loader2 className="animate-spin text-foreground" size={20} />
                                                        </div>
                                                    )}
                                                </div>
                                            ))}

                                            {/* Add Button */}
                                            <div
                                                onClick={() => document.getElementById('image-upload')?.click()}
                                                className="aspect-video border-2 border-dashed border-glass-border rounded-xl flex flex-col items-center justify-center bg-glass hover:bg-hover-bg transition-colors cursor-pointer relative min-h-[100px]"
                                            >
                                                <input
                                                    id="image-upload"
                                                    type="file"
                                                    accept="image/*"
                                                    multiple
                                                    className="hidden"
                                                    onChange={(e) => handleImageSelect(e.target.files)}
                                                />
                                                <Plus className="text-text-secondary mb-2" size={24} />
                                                <p className="text-text-secondary text-xs font-medium">Add Image</p>
                                            </div>
                                        </div>

                                        {/* Quick Select from Assets (Only in Upload Mode) */}
                                        {availableAssets.length > 0 && (
                                            <div className="mt-4 pt-4 border-t border-glass-border">
                                                <p className="text-xs text-text-muted mb-2">Quick Select from Assets:</p>
                                                <div className="flex gap-2 overflow-x-auto pb-2 scrollbar-hide">
                                                    {availableAssets.slice(0, 10).map((asset, i) => (
                                                        <div
                                                            key={i}
                                                            onClick={() => handleAssetSelect(asset.url)}
                                                            className="w-16 h-16 relative rounded-lg overflow-hidden flex-shrink-0 border border-glass-border hover:border-primary cursor-pointer"
                                                        >
                                                            <img src={asset.url} alt={asset.title} className="w-full h-full object-cover" />
                                                        </div>
                                                    ))}
                                                </div>
                                            </div>
                                        )}
                                    </div>
                                )}
                            </div>
                        </div>
                    )}

                    {/* === R2V MODE: consecutive shots + references + Motion Skill === */}
                    {generationMode === 'r2v' && (
                        <div className="space-y-6">
                            <div className="space-y-3">
                                <div className="flex items-center justify-between gap-3">
                                    <label className="text-sm font-medium text-text-secondary">连续镜头</label>
                                    <span className="flex items-center gap-2 text-xs text-text-muted">
                                        {selectedFrameIds.length
                                            ? `已选 ${selectedFrameIds.length} 个镜头 · ${shotTiming.duration === null ? '时长待补齐' : `合计 ${shotTiming.duration} 秒`}`
                                            : "点击起点，再点击终点"}
                                        {selectedFrameIds.length > 0 && (
                                            <button
                                                type="button"
                                                onClick={() => {
                                                    setSelectedFrameIds([]);
                                                    setFrameSelectionAnchor(null);
                                                }}
                                                className="flex items-center gap-1 rounded border border-glass-border px-2 py-0.5 font-medium text-text-secondary hover:border-primary/50 hover:text-primary"
                                            >
                                                <X size={10} />
                                                清空
                                            </button>
                                        )}
                                    </span>
                                </div>
                                {durationError && <p className="text-xs text-amber-500" role="alert">{durationError}</p>}
                                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 max-h-[260px] overflow-y-auto custom-scrollbar pr-2">
                                    {currentProject?.frames && currentProject.frames.length > 0 ? (
                                        currentProject.frames.map((frame: any, index: number) => (
                                            <div
                                                key={frame.id}
                                                onClick={() => handleR2VFrameSelect(frame)}
                                                className={`p-3 rounded-lg border cursor-pointer transition-all ${selectedFrameIds.includes(frame.id)
                                                    ? "border-primary bg-primary/10 ring-2 ring-primary/30"
                                                    : "border-glass-border bg-surface hover:border-glass-border"
                                                    }`}
                                            >
                                                <div className="flex items-start gap-3">
                                                    {/* Frame thumbnail */}
                                                    <div className="w-16 h-10 rounded overflow-hidden flex-shrink-0 bg-surface">
                                                        {frame.image_url ? (
                                                            <img
                                                                src={getAssetUrlWithTimestamp(frame.image_url, frame.updated_at)}
                                                                alt=""
                                                                className="w-full h-full object-cover"
                                                            />
                                                        ) : (
                                                            <div className="w-full h-full flex items-center justify-center text-text-muted">
                                                                <Layout size={14} />
                                                            </div>
                                                        )}
                                                    </div>
                                                    {/* Frame description */}
                                                    <div className="flex-1 min-w-0">
                                                        <p className="text-xs text-text-secondary mb-1">镜头 {String(index + 1).padStart(2, "0")} · {frame.duration > 0 ? `${frame.duration}秒` : '时长未设置'}</p>
                                                        <p className="text-xs text-text-secondary line-clamp-2">
                                                            {frame.action_description || frame.image_prompt || 'No description'}
                                                        </p>
                                                        {frame.dialogue && (
                                                            <p className="text-[0.625rem] text-primary mt-1 italic line-clamp-1">
                                                                “{frame.dialogue}”
                                                            </p>
                                                        )}
                                                    </div>
                                                    {/* Selected indicator */}
                                                    {selectedFrameIds.includes(frame.id) && (
                                                        <div className="w-5 h-5 rounded-full bg-primary flex items-center justify-center flex-shrink-0">
                                                            <Check size={12} className="text-white" />
                                                        </div>
                                                    )}
                                                </div>
                                            </div>
                                        ))
                                    ) : (
                                        <div className="col-span-2 flex flex-col items-center justify-center h-[100px] text-text-muted gap-2">
                                            <Layout size={24} className="opacity-20" />
                                            <p className="text-xs">{tc("noFrameSelected")}</p>
                                        </div>
                                    )}
                                </div>
                            </div>

                            <div className="space-y-3">
                                <div className="flex items-center justify-between gap-3">
                                    <label className="text-sm font-medium text-text-secondary">参考图（角色 / 场景 / 道具）</label>
                                    <span className="flex items-center gap-2 text-xs">
                                        <button
                                            type="button"
                                            onClick={handleAutoBindReferences}
                                            disabled={!selectedFrameIds.length}
                                            title={tc("autoBindHint")}
                                            className="flex items-center gap-1 rounded border border-glass-border px-2 py-0.5 font-medium text-text-secondary transition-colors hover:border-primary/50 hover:text-primary disabled:cursor-not-allowed disabled:opacity-40"
                                        >
                                            <Wand2 size={10} />
                                            {tc("autoBind")}
                                        </button>
                                        <span className={referenceAssets.length > referenceImageLimit ? "font-semibold text-red-400" : "text-text-muted"}>
                                            {referenceAssets.length} / {referenceImageLimit}
                                        </span>
                                    </span>
                                </div>
                                {r2vUsesImages ? (
                                    /* Image-based R2V: slot count follows the gateway contract. */
                                    <>
                                        <div className="grid grid-cols-3 gap-3">
                                            {Array.from({ length: Math.min(Math.max(castSlots.filter(s => s.url).length + 1, 3), referenceImageLimit) }, (_, slotIndex) => {
                                                const slot = castSlots[slotIndex];
                                                const refImage = slot?.url ? availableReferenceImages.find(img => img.url === slot.url) : null;

                                                return (
                                                    <div
                                                        key={slotIndex}
                                                        className={`relative rounded-xl border-2 border-dashed transition-all ${slot?.url
                                                            ? "border-primary bg-primary/10"
                                                            : "border-glass-border bg-surface hover:border-glass-border"
                                                            }`}
                                                    >
                                                        {/* Slot Header */}
                                                        <div className="absolute top-2 left-2 z-10">
                                                            <span className="text-[0.625rem] px-2 py-0.5 rounded-full bg-primary text-white font-bold">
                                                                参考图 {slotIndex + 1}
                                                            </span>
                                                        </div>

                                                        {slot?.url ? (
                                                            /* Filled Slot - show image */
                                                            <div className="aspect-square relative">
                                                                <img
                                                                    src={refImage?.thumbnail || getAssetUrl(slot.url)}
                                                                    alt={slot.name}
                                                                    className="w-full h-full object-cover rounded-xl"
                                                                />
                                                                <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/80 to-transparent p-2 rounded-b-xl">
                                                                    <p className="text-xs text-foreground font-medium truncate">{slot.name} · {slot.type}</p>
                                                                </div>
                                                                <button
                                                                    onClick={() => handleClearCastSlot(slotIndex)}
                                                                    className="absolute top-2 right-2 p-1 bg-surface rounded-full text-foreground hover:bg-red-500 transition-colors"
                                                                >
                                                                    <X size={12} />
                                                                </button>
                                                            </div>
                                                        ) : (
                                                            /* Empty Slot */
                                                            <div className="aspect-square flex flex-col items-center justify-center p-3">
                                                                <ImageIcon size={16} className="text-text-muted mb-1" />
                                                                <select
                                                                    className="w-full text-xs bg-input-bg border border-glass-border rounded-lg px-2 py-1.5 text-text-secondary focus:border-primary focus:outline-none"
                                                                    value=""
                                                                    onChange={(e) => {
                                                                        const selectedImg = availableReferenceImages.find(img => img.url === e.target.value);
                                                                        if (selectedImg) {
                                                                            handleCastSlotSelect(slotIndex, { url: selectedImg.url, name: selectedImg.assetName });
                                                                        }
                                                                    }}
                                                                >
                                                                    <option value="">{tc('selectImage')}</option>
                                                                    {availableReferenceImages.map((img, i) => (
                                                                        <option key={i} value={img.url}>{img.assetName} - {img.type}</option>
                                                                    ))}
                                                                </select>
                                                                {slotIndex === 0 && (
                                                                    <p className="text-[0.625rem] text-amber-400 mt-1">Required</p>
                                                                )}
                                                            </div>
                                                        )}
                                                    </div>
                                                );
                                            })}
                                        </div>
                                        <div className="flex items-center justify-between gap-3">
                                            <p className="text-xs text-text-muted">按选择顺序作为参考图提交；最多 {referenceImageLimit} 张。</p>
                                            <label className="cursor-pointer rounded border border-border-subtle px-2 py-1.5 text-xs text-primary hover:bg-hover-bg">
                                                {isUploadingReference ? <Loader2 size={13} className="mr-1 inline animate-spin" /> : <Upload size={13} className="mr-1 inline" />}
                                                上传参考图
                                                <input type="file" accept="image/jpeg,image/png" multiple className="hidden" onChange={(event) => uploadReferences(event.target.files)} />
                                            </label>
                                        </div>
                                        {availableReferenceImages.length === 0 && (
                                            <p className="text-xs text-amber-400 bg-amber-500/10 border border-amber-500/30 rounded-lg p-3">
                                                资产库暂无可用图片，可直接上传参考图。
                                            </p>
                                        )}
                                    </>
                                ) : (
                                    /* Wan R2V: Video reference slots (3) */
                                    <>
                                        <div className="grid grid-cols-3 gap-4">
                                            {[0, 1, 2].map((slotIndex) => {
                                                const slot = castSlots[slotIndex];
                                                const slotTitle = slotIndex === 0 ? 'Protagonist' : 'Supporting';
                                                const video = slot?.url ? availableReferenceVideos.find(v => v.url === slot.url) : null;

                                                return (
                                                    <div
                                                        key={slotIndex}
                                                        className={`relative rounded-xl border-2 border-dashed transition-all ${slot?.url
                                                            ? "border-primary bg-primary/10"
                                                            : "border-glass-border bg-surface hover:border-glass-border"
                                                            }`}
                                                    >
                                                        {/* Slot Header */}
                                                        <div className="absolute top-2 left-2 z-10">
                                                            <span className="text-[0.625rem] px-2 py-0.5 rounded-full bg-primary text-white font-bold">
                                                                Character {slotIndex + 1}
                                                            </span>
                                                        </div>

                                                        {slot?.url ? (
                                                            /* Filled Slot */
                                                            <div className="aspect-video relative">
                                                                <img
                                                                    src={getAssetUrl(video?.thumbnail || '')}
                                                                    alt={slot.name}
                                                                    className="w-full h-full object-cover rounded-xl"
                                                                />
                                                                <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/80 to-transparent p-2 rounded-b-xl">
                                                                    <p className="text-xs text-foreground font-medium truncate">{slot.name}</p>
                                                                </div>
                                                                <button
                                                                    onClick={() => handleClearCastSlot(slotIndex)}
                                                                    className="absolute top-2 right-2 p-1 bg-surface rounded-full text-foreground hover:bg-red-500 transition-colors"
                                                                >
                                                                    <X size={12} />
                                                                </button>
                                                            </div>
                                                        ) : (
                                                            /* Empty Slot */
                                                            <div className="aspect-video flex flex-col items-center justify-center p-4">
                                                                <p className="text-xs text-text-secondary mb-2">{slotTitle}</p>
                                                                <select
                                                                    className="w-full text-xs bg-input-bg border border-glass-border rounded-lg px-2 py-1.5 text-text-secondary focus:border-primary focus:outline-none"
                                                                    value=""
                                                                    onChange={(e) => {
                                                                        const selectedVideo = availableReferenceVideos.find(v => v.url === e.target.value);
                                                                        if (selectedVideo) {
                                                                            handleCastSlotSelect(slotIndex, { url: selectedVideo.url, name: selectedVideo.assetName });
                                                                        }
                                                                    }}
                                                                >
                                                                    <option value="">{tc('selectRefVideo')}</option>
                                                                    {availableReferenceVideos.map((v, i) => (
                                                                        <option key={i} value={v.url}>{v.assetName} - {v.type}</option>
                                                                    ))}
                                                                </select>
                                                                {slotIndex === 0 && (
                                                                    <p className="text-[0.625rem] text-amber-400 mt-2">Required</p>
                                                                )}
                                                            </div>
                                                        )}
                                                    </div>
                                                );
                                            })}
                                        </div>
                                        {availableReferenceVideos.length === 0 && (
                                            <p className="text-xs text-amber-400 bg-amber-500/10 border border-amber-500/30 rounded-lg p-3">
                                                {tc('noRefVideosAvailable')}
                                            </p>
                                        )}
                                    </>
                                )}
                            </div>

                            <div className="flex items-center justify-between rounded-lg border border-border-subtle bg-surface p-4">
                                <div className="min-w-0 flex-1"><p className="text-sm font-medium text-text-secondary">提示词配置</p><p className="mt-1 text-xs text-text-muted">选择 Skill 后生成对应提示词，参考图可稍后绑定。</p></div>
                                <select
                                    value={selectedPromptPreset}
                                    disabled={isGeneratingPrompt || h3.busy}
                                    onChange={(e) => setSelectedPromptPreset(e.target.value)}
                                    className="max-w-[220px] rounded border border-glass-border bg-surface px-2 py-1.5 text-xs text-foreground"
                                    aria-label="提示词 Skill"
                                >
                                    <option value="r2v">提示词配置 · R2V</option>
                                    <option value="r2v_minimax">MiniMax 参考生视频 Skill</option>
                                    {h3SkillAvailable && <option value={H3_SKILL_ID}>MiniMax H3 提示词增强 · 内置</option>}
                                </select>
                                <button type="button" onClick={assembleMotionPrompt} disabled={isGeneratingPrompt || h3.busy || !selectedFrameIds.length} className="rounded border border-glass-border px-3 py-1.5 text-xs font-medium text-text-secondary hover:border-primary/50 hover:text-primary disabled:opacity-40">
                                    拼装提示词
                                </button>
                                <button type="button" onClick={generateMotionPrompt} disabled={isGeneratingPrompt || h3.busy || !selectedFrameIds.length || (isH3PromptSkill && (!!h3Invalid || !!h3.pendingId))} className="rounded bg-primary px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40">
                                    {isGeneratingPrompt || h3.busy ? <Loader2 size={13} className="mr-1 inline animate-spin" /> : <Wand2 size={13} className="mr-1 inline" />}
                                    {isH3PromptSkill ? isGeneratingPrompt || h3.busy ? "增强中..." : "增强提示词" : promptJobStatus === "running" ? "生成中..." : promptJobStatus === "queued" ? "排队中..." : "生成提示词"}
                                </button>
                            </div>
                            {isH3PromptSkill && <p className="text-xs text-text-muted">H3 提示词增强 · {shotTiming.duration ?? '未填写'} 秒 · {h3Ratio}。按当前顺序读取并上传参考图；空白提示词按所选镜头本地拼装后增强。</p>}
                            {isH3PromptSkill && h3Invalid && <p className="text-xs text-red-400">{h3Invalid}</p>}
                            {motionError && <p className="text-xs text-red-400">{motionError}</p>}
                        </div>
                    )}


                    <H3EnhancementStatus {...h3} onResume={h3.resume} onClear={h3.clear} />
                    {h3.job?.status === 'completed' && <div className="space-y-3 rounded-lg border border-primary/30 bg-surface p-4">
                        <p className="text-sm font-medium text-text-secondary">H3 增强结果预览</p>
                        <details className="text-xs text-text-muted"><summary className="cursor-pointer">增强前提示词</summary><pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap font-sans">{h3.job.source_text}</pre></details>
                        <pre className="max-h-80 overflow-auto whitespace-pre-wrap text-sm text-foreground custom-scrollbar">{h3.job.text}</pre>
                        {h3.job.source_context !== h3SourceContext && <p className="text-xs text-red-400">原文、镜头或参数已变化，请复制结果或放弃后重新增强。</p>}
                        <div className="flex gap-3 text-xs">
                            <button type="button" disabled={h3.job.source_context !== h3SourceContext || h3.job.text.length > 12000} className="rounded bg-primary px-3 py-2 text-on-accent disabled:opacity-40" onClick={adoptH3Prompt}>采用增强结果</button>
                            <button type="button" className="text-primary" onClick={() => { void navigator.clipboard.writeText(h3.job!.text).then(() => toast.success('已复制增强结果')).catch(() => toast.error('复制失败')); }}>复制结果</button>
                            <button type="button" className="text-text-secondary" onClick={h3.clear}>放弃结果</button>
                        </div>
                    </div>}
                    {h3Original && <button type="button" className="text-xs text-primary" onClick={() => {
                        if (prompt !== h3Original.appliedText) { setMotionError('采用后正文已有修改，未覆盖当前内容。'); return; }
                        setSegments(h3Original.segments); setH3Original(null); setMotionError('');
                    }}>恢复增强前提示词</button>}
                    {/* 2. Prompt Input */}
                    <div className="space-y-2">
                        <div className="flex justify-between items-center">
                            <label className="text-sm font-medium text-text-secondary">{tc("promptLabel")}</label>
                            <div className="flex items-center gap-2">
                                {generationMode === 'i2v' && (
                                    <div className="relative">
                                        <button
                                            onClick={() => promptBuilderRef.current?.insertCamera()}
                                            className="text-xs flex items-center gap-1 px-2 py-1 rounded transition-colors text-text-secondary hover:text-foreground hover:bg-glass"
                                        >
                                            <Video size={12} /> Camera
                                        </button>
                                    </div>
                                )}
                                <button
                                    onClick={() => handlePolish()}
                                    disabled={isPolishing || !prompt}
                                    className="text-xs text-primary hover:text-primary/80 flex items-center gap-1 disabled:opacity-50"
                                >
                                    {isPolishing ? <Loader2 size={12} className="animate-spin" /> : <Wand2 size={12} />}
                                    {tc("aiPolish")}
                                </button>
                                <button
                                    onClick={() => setSegments([{ type: "text", value: "", id: "init" }])}
                                    className="text-xs text-text-secondary hover:text-foreground flex items-center gap-1 px-2 py-1 rounded hover:bg-glass transition-colors"
                                    title="Clear Prompt"
                                >
                                    <Eraser size={12} /> Clear
                                </button>
                            </div>
                        </div>

                        <div className="relative">
                            <PromptBuilder
                                ref={promptBuilderRef}
                                segments={segments}
                                onChange={setSegments}
                                placeholder={generationMode === 'r2v'
                                    ? tc('promptPlaceholder')
                                    : tc("promptPlaceholder")
                                }
                            />
                            {generationMode === 'r2v' && (
                                <span className={`absolute bottom-2 right-3 text-[0.625rem] ${prompt.length > promptLimit ? "text-red-400" : "text-text-muted"}`}>
                                    {prompt.length} / {promptLimit}
                                </span>
                            )}
                        </div>

                        {/* Polished Result Display - Bilingual */}
                        <AnimatePresence>
                            {polishedPrompt && (
                                <motion.div
                                    initial={{ opacity: 0, y: -10 }}
                                    animate={{ opacity: 1, y: 0 }}
                                    exit={{ opacity: 0, y: -10 }}
                                    className="bg-primary/10 border border-primary/30 rounded-lg p-3 mt-2 space-y-3"
                                >
                                    <div className="flex justify-between items-start">
                                        <span className="text-xs font-bold text-primary flex items-center gap-1">
                                            <Wand2 size={12} /> {tc("aiPolish")}
                                        </span>
                                        <button
                                            onClick={() => { setPolishedPrompt(null); setFeedbackText(""); }}
                                            className="text-[0.625rem] text-text-secondary hover:text-foreground"
                                        >
                                            ✕
                                        </button>
                                    </div>

                                    {/* Chinese Prompt */}
                                    <div className="space-y-1">
                                        <div className="flex justify-between items-center">
                                            <span className="text-[0.625rem] font-bold text-text-muted uppercase">CN (Preview)</span>
                                            <button
                                                onClick={() => {
                                                    navigator.clipboard.writeText(polishedPrompt.cn);
                                                    alert("CN prompt copied");
                                                }}
                                                className="text-[0.625rem] text-text-secondary hover:text-foreground bg-surface px-2 py-0.5 rounded"
                                            >
                                                复制
                                            </button>
                                        </div>
                                        <p className="text-xs text-text-secondary leading-relaxed whitespace-pre-wrap bg-surface p-2 rounded">
                                            {polishedPrompt.cn}
                                        </p>
                                    </div>

                                    {/* English Prompt */}
                                    <div className="space-y-1">
                                        <div className="flex justify-between items-center">
                                            <span className="text-[0.625rem] font-bold text-text-muted uppercase">EN (Generation)</span>
                                            <div className="flex gap-1">
                                                <button
                                                    onClick={() => {
                                                        navigator.clipboard.writeText(polishedPrompt.en);
                                                        alert("English prompt copied");
                                                    }}
                                                    className="text-[0.625rem] text-text-secondary hover:text-foreground bg-surface px-2 py-0.5 rounded"
                                                >
                                                    Copy
                                                </button>
                                                <button
                                                    onClick={() => {
                                                        setSegments([{ type: "text", value: polishedPrompt.en, id: `polished-${Date.now()}` }]);
                                                        setPolishedPrompt(null);
                                                    }}
                                                    className="text-[0.625rem] text-foreground bg-primary hover:bg-primary/90 px-2 py-0.5 rounded font-bold"
                                                >
                                                    应用
                                                </button>
                                            </div>
                                        </div>
                                        <p className="text-xs text-text-secondary leading-relaxed whitespace-pre-wrap bg-surface p-2 rounded font-mono">
                                            {polishedPrompt.en}
                                        </p>
                                    </div>

                                    {/* Feedback for iterative refinement */}
                                    <div className="space-y-2 pt-2 border-t border-primary/20">
                                        <div className="flex gap-2">
                                            <input
                                                type="text"
                                                value={feedbackText}
                                                onChange={(e) => setFeedbackText(e.target.value)}
                                                onKeyDown={(e) => {
                                                    if (e.key === "Enter" && feedbackText.trim() && !isPolishing) {
                                                        handlePolish(feedbackText.trim());
                                                    }
                                                }}
                                                placeholder="Feedback for refinement..."
                                                className="flex-1 text-xs bg-input-bg border border-primary/20 rounded px-2 py-1.5 text-foreground placeholder-text-muted focus:outline-none focus:border-primary/50"
                                            />
                                            <button
                                                onClick={() => handlePolish(feedbackText.trim())}
                                                disabled={isPolishing || !feedbackText.trim()}
                                                className="text-xs text-foreground bg-primary hover:bg-primary/90 px-3 py-1.5 rounded font-medium flex items-center gap-1 disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"
                                            >
                                                {isPolishing ? <Loader2 size={10} className="animate-spin" /> : <Wand2 size={10} />}
                                                再润色
                                            </button>
                                        </div>
                                    </div>
                                </motion.div>
                            )}
                        </AnimatePresence>
                    </div>
                </div>
            </div >

            {/* 4. Fixed Action Bar */}
            < div className="p-6 border-t border-glass-border bg-surface z-10" >
                <div className="max-w-4xl mx-auto w-full">
                    <button
                        onClick={handleSubmit}
                        disabled={isSubmitting || !prompt || !!durationError || !outputDuration || (generationMode === 'i2v'
                            ? selectedImages.length === 0
                            : (!selectedFrameIds.length || !referenceAssets.length || prompt.length > promptLimit))}
                        className={`w-full py-4 rounded-xl font-bold text-lg flex items-center justify-center gap-2 transition-all transform active:scale-[0.99] ${submitSuccess
                            ? "bg-green-500 text-white"
                            : "bg-primary hover:bg-primary/90 text-white"
                            } disabled:opacity-50 disabled:cursor-not-allowed`}
                    >
                        {isSubmitting ? (
                            <>
                                <Loader2 className="animate-spin" /> {tc("generatingVideo")}
                            </>
                        ) : submitSuccess ? (
                            <>
                                <Plus /> Queued
                            </>
                        ) : (
                            <>
                                <Plus /> {tc("generateVideo")} (Ctrl+Enter)
                            </>
                        )}
                    </button>
                    <div className="flex justify-center mt-3">
                        <label className="flex items-center gap-2 text-xs text-text-muted cursor-pointer hover:text-text-secondary">
                            <input type="checkbox" className="rounded bg-glass border-glass-border" />
                            Clear after submit
                        </label>
                    </div>
                </div>
            </div >
        </div >
    );
}
