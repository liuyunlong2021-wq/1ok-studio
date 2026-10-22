"use client";
/**
 * Cast — R2V workflow Step 3「本集素材」（per-episode asset view）。
 *
 * Design v2 决策（docs/design/r2v-workflow-v2.md Q8 / Q9）:
 *   · Cast = per-episode lens (read-only) of frame-referenced assets
 *   · Series-level CRUD lives in SeriesDetailPage (Characters/Scenes/Props tabs)
 *   · ConsistencyVault is preserved for i2v_legacy workflow only
 *   · Three sections stacked: characters / scenes / props
 *   · Each card: thumb + name + appearance count + status badge
 *     (✓ ready / ⚠ pending / 🆕 new-this-episode)
 *
 * Phase 1 scope (this file):
 *   · Read-only aggregation of frames[].character_ids / scene_id / prop_ids
 *   · Three section grid render
 *   · Status badges based on reference image presence
 *   · NO reconcile flow yet (Phase 4)
 *   · NO `+ new asset` / generation modal yet (Phase 5)
 *   · NO inspector right rail yet (Q9 decision: 3-section flat, no inspector)
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Users, MapPin, Box, AlertTriangle, Sparkles, Plus, Upload, X, Loader2, Play, Wand2, Layers, Maximize2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useProjectStore } from "@/store/projectStore";
import { api } from "@/lib/api";
import { getAssetUrl } from "@/lib/utils";
import { useLightbox } from "@/components/shared/preview/LightboxProvider";
import StepPageHeader, { StepPill } from "@/components/shared/StepPageHeader";
import PreviewImage from "@/components/shared/preview/PreviewImage";
import WorkflowActionButton from "@/components/shared/WorkflowActionButton";
import { toast } from "@/store/toastStore";
import CastWorkbenchModal, { activePolls, assetTaskKey, startAssetPoll } from "./cast/CastWorkbenchModal";
import { characterImageUrl, scenePropImageUrl } from "@/lib/characterImage";
import ReconcileAction from "./ReconcileAction";
import ProductionExtractionPreview from "./cast/ProductionExtractionPreview";

type AssetKind = "character" | "scene" | "prop";
const VOICE_KEYS = ["年龄感", "音高", "明暗", "厚薄", "共鸣", "气息", "颗粒感", "口音", "稳定表达习惯"] as const;

async function waitForProductionAssetPrompt(projectId: string, assetId: string, kind: AssetKind, update: (id: string, project: any) => void, lookId?: string) {
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        const project = await api.getProject(projectId);
        update(projectId, project);
        const pool = kind === "character" ? project.characters : kind === "scene" ? project.scenes : project.props;
        const owner = (pool || []).find((item: any) => item.id === assetId);
        const asset = lookId ? owner?.looks?.find((look: any) => look.id === lookId) : owner;
        if (asset?.prompt_generation_status === "completed") return;
        if (["failed", "stale"].includes(asset?.prompt_generation_status)) {
            throw new Error(asset.prompt_generation_error || "资产提示词生成失败，请重试");
        }
    }
    throw new Error("提示词仍在后台处理中；稍后可重新打开资产查看状态");
}

async function waitForProductionAssetExtraction(projectId: string, taskId: string, update: (id: string, project: any) => void) {
    const deadline = Date.now() + 300_000;
    while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        const project = await api.getProject(projectId);
        update(projectId, project);
        const task = project.production_asset_extraction_task;
        if (task?.task_id !== taskId) throw new Error("资产提取任务版本已变化，请刷新项目后重试");
        if (task.status === "completed" && project.production_asset_preview?.extraction_task_id === taskId) {
            return project.production_asset_preview;
        }
        if (["failed", "stale"].includes(task.status)) throw new Error(task.error || "资产提取失败，请重试");
    }
    throw new Error("资产仍在后台提取；稍后可重新打开项目查看状态");
}

async function waitForProductionVoiceDesign(projectId: string, assetId: string, taskId: string, update: (id: string, project: any) => void) {
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        const project = await api.getProject(projectId);
        update(projectId, project);
        const character = (project.characters || []).find((item: any) => item.id === assetId);
        const task = character?.voice_design_task;
        if (task?.task_id !== taskId) throw new Error("角色声音任务版本已变化，请刷新后重试");
        if (task.status === "completed") return character.voice_design || {};
        if (["failed", "stale"].includes(task.status)) throw new Error(task.error || "九维声音档案生成失败");
    }
    throw new Error("声音档案仍在后台处理中；稍后可重新打开角色查看状态");
}

interface CastItem {
    id: string;
    name: string;
    kind: AssetKind;
    appearances: number;            // 出场次数（在多少 frame 中被引用）
    referenceImageUrl?: string;     // 参考图（优先 reference_sheet → full_body fallback）
    status: "ready" | "pending" | "new";
    persona?: string;               // R2V v2 P1-a — characters only; groups visual variants of same person
    description?: string;
    looksCount?: number;
    source?: string;
}

/**
 * 取图统一走 `lib/characterImage` —— 三处（Cast / 旧资产库 / 资产库页）都曾经
 * 各写一份，漏字段的那份就会把有图的资产rendered成空占位。
 */

export default function Cast() {
    const tStep = useTranslations("stepHeader");
    const t = useTranslations("cast");
    const tWorkbench = useTranslations("castWorkbench");
    const currentProject = useProjectStore((state) => state.currentProject);

    // R2V v2 Phase 5 — add new asset modal (placeholder for full
    // generation flow which lands in a follow-up patch). For now this
    // opens a TODO dialog showing the planned two-tab interface.
    const [addModalOpen, setAddModalOpen] = useState<null | "character" | "scene" | "prop">(null);
    // PR-3* · Cast redesign — tab filter + workbench launcher.
    const [activeTab, setActiveTab] = useState<"all" | "character" | "scene" | "prop">("all");
    const [workbench, setWorkbench] = useState<{ kind: "character" | "scene" | "prop"; entityId: string } | null>(null);
    const [productionPreview, setProductionPreview] = useState<any>(null);
    const [productionAssetBusy, setProductionAssetBusy] = useState("");

    const removeGeneratingTask = useProjectStore((s) => s.removeGeneratingTask);
    const addGeneratingTask = useProjectStore((s) => s.addGeneratingTask);
    const updateProject = useProjectStore((s) => s.updateProject);
    const generatingTasks = useProjectStore((s) => s.generatingTasks);
    const [selectedProductionAssets, setSelectedProductionAssets] = useState<string[]>([]);
    const [bulkProductionBusy, setBulkProductionBusy] = useState("");
    useEffect(() => {
        if (generatingTasks.length === 0) return;
        for (const task of generatingTasks) {
            if (!activePolls.has(task.assetId)) {
                removeGeneratingTask(task.assetId, task.generationType);
            }
        }
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    /**
     * Aggregate per-asset appearance counts from frame references, then
     * union with the project's entity pool so freshly-extracted assets
     * (which have NO frame references yet — frames are created in a
     * separate '生成分镜' step) still show up in Cast.
     *
     * Earlier this only listed entities discovered through frame iteration,
     * which silently dropped every extracted character/scene/prop until
     * the user generated frames. The toast said 'extraction done' but
     * Cast looked empty.
     */
    const { characters, scenes, props } = useMemo(() => {
        const characterCounts = new Map<string, number>();
        const sceneCounts = new Map<string, number>();
        const propCounts = new Map<string, number>();
        const frames: any[] = currentProject?.frames ?? [];
        for (const f of frames) {
            if (f?.scene_id) sceneCounts.set(f.scene_id, (sceneCounts.get(f.scene_id) ?? 0) + 1);
            for (const cid of f?.character_ids ?? []) {
                characterCounts.set(cid, (characterCounts.get(cid) ?? 0) + 1);
            }
            for (const pid of f?.prop_ids ?? []) {
                propCounts.set(pid, (propCounts.get(pid) ?? 0) + 1);
            }
        }
        const production = currentProject?.production_workflow === "engineering_segments_v1";
        // Project GET merges every series/global asset for legacy library workflows.
        // In production, only show shared assets actually referenced by this episode;
        // keep all episode-local extraction results, including not-yet-bound assets.
        const relevant = (asset: any, counts: Map<string, number>) =>
            !production || asset.source === "episode" || (counts.get(asset.id) ?? 0) > 0;
        const characterPool: any[] = (currentProject?.characters ?? []).filter((asset: any) => relevant(asset, characterCounts));
        const scenePool: any[] = (currentProject?.scenes ?? []).filter((asset: any) => relevant(asset, sceneCounts));
        const propPool: any[] = (currentProject?.props ?? []).filter((asset: any) => relevant(asset, propCounts));

        const characters: CastItem[] = characterPool.map((c: any) => {
            const imageUrl = characterImageUrl(c);
            return {
                id: c.id,
                name: c.name ?? c.id,
                kind: "character" as const,
                appearances: characterCounts.get(c.id) ?? 0,
                looksCount: c.looks?.length || 0,
                referenceImageUrl: imageUrl,
                status: (imageUrl ? "ready" : "pending") as "ready" | "pending",
                persona: c.persona ?? "",
                description: c.description ?? "",
                source: c.source,
            };
        }).sort((a, b) => b.appearances - a.appearances || a.name.localeCompare(b.name));

        const scenes: CastItem[] = scenePool.map((s: any) => {
            const imageUrl = scenePropImageUrl(s);
            return {
                id: s.id,
                name: s.name ?? s.id,
                kind: "scene" as const,
                appearances: sceneCounts.get(s.id) ?? 0,
                referenceImageUrl: imageUrl,
                status: (imageUrl ? "ready" : "pending") as "ready" | "pending",
                description: s.description ?? "",
                source: s.source,
            };
        }).sort((a, b) => b.appearances - a.appearances || a.name.localeCompare(b.name));

        const props: CastItem[] = propPool.map((p: any) => {
            const imageUrl = scenePropImageUrl(p);
            return {
                id: p.id,
                name: p.name ?? p.id,
                kind: "prop" as const,
                appearances: propCounts.get(p.id) ?? 0,
                referenceImageUrl: imageUrl,
                status: (imageUrl ? "ready" : "pending") as "ready" | "pending",
                description: p.description ?? "",
                source: p.source,
            };
        }).sort((a, b) => b.appearances - a.appearances || a.name.localeCompare(b.name));

        return { characters, scenes, props };
    }, [currentProject?.frames, currentProject?.characters, currentProject?.scenes, currentProject?.props]);

    const totalCast = characters.length + scenes.length + props.length;
    const production = currentProject?.production_workflow === "engineering_segments_v1";
    const visibleTab = production && activeTab === "all" ? "character" : activeTab;
    const visibleProductionAssetIds = new Set([...characters, ...scenes, ...props].map((item) => item.id));
    const productionAssets = [
        ...(currentProject?.characters || []).filter((item: any) => !production || visibleProductionAssetIds.has(item.id)).flatMap((item: any) => {
            const used = new Set((currentProject?.frames || []).filter((frame: any) => frame.character_ids?.includes(item.id)).map((frame: any) => frame.character_look_ids?.[item.id]).filter(Boolean));
            const looks = item.looks?.length ? item.looks.filter((look: any) => !used.size || used.has(look.id)) : [undefined];
            return looks.map((look: any) => ({ id: item.id, lookId: look?.id as string | undefined, key: assetTaskKey(currentProject!.id, item.id, look?.id), name: look ? `${item.name} · ${look.name}` : item.name, kind: "character" as const, description: item.description || "", source: item.source, locked: !!item.locked || !!look?.locked, imagePrompt: (look || item).prompt_generation_status === "stale" && (look || item).reference_sheet?.image_prompt_source !== "manual" ? "" : look ? look.reference_sheet?.image_prompt || "" : item.reference_sheet?.image_prompt || item.full_body_prompt || "", hasImage: !!characterImageUrl(item, look?.id), voice: item.voice_design || {} }));
        }),
        ...(currentProject?.scenes || []).filter((item: any) => !production || visibleProductionAssetIds.has(item.id)).map((item: any) => ({ id: item.id, key: item.id, lookId: undefined as string | undefined, name: item.name, kind: "scene" as const, description: item.description || "", source: item.source, locked: !!item.locked, imagePrompt: item.image_prompt || "", hasImage: !!scenePropImageUrl(item), voice: {} })),
        ...(currentProject?.props || []).filter((item: any) => !production || visibleProductionAssetIds.has(item.id)).map((item: any) => ({ id: item.id, key: item.id, lookId: undefined as string | undefined, name: item.name, kind: "prop" as const, description: item.description || "", source: item.source, locked: !!item.locked, imagePrompt: item.image_prompt || "", hasImage: !!scenePropImageUrl(item), voice: {} })),
    ];
    const previewProductionAssets = async () => {
        if (!currentProject) return;
        setProductionAssetBusy("preview");
        try {
            const task = await api.previewProductionAssets(currentProject.id);
            setProductionPreview(await waitForProductionAssetExtraction(currentProject.id, task.task_id, updateProject));
        }
        catch (error) {
            const detail = (error as { response?: { data?: { detail?: unknown } } })?.response?.data?.detail;
            toast.error("资产提取失败", { body: typeof detail === "string" ? detail : error instanceof Error ? error.message : "请重试。" });
        } finally { setProductionAssetBusy(""); }
    };
    const applyProductionAssets = async () => {
        if (!currentProject || !productionPreview) return;
        setProductionAssetBusy("apply");
        try {
            await api.applyProductionAssets(currentProject.id, productionPreview.source_revision, productionPreview.screenplay_revision, productionPreview.shot_bindings);
            useProjectStore.getState().updateProject(currentProject.id, await api.getProject(currentProject.id));
            setProductionPreview(null);
            toast.success("资产与工程镜头已绑定", { body: "角色的九维声音档案可在角色工作台中补充。" });
        } catch (error) {
            const detail = (error as { response?: { data?: { detail?: unknown } } })?.response?.data?.detail;
            toast.error("采用资产失败", { body: typeof detail === "string" ? detail : error instanceof Error ? error.message : "请重新预览。" });
        } finally { setProductionAssetBusy(""); }
    };
    const generateSelectedPrompts = async () => {
        if (!currentProject) return;
        const selected = productionAssets.filter((item) => selectedProductionAssets.includes(item.key) && !item.locked);
        if (!selected.length) return;
        const remapped: Record<string, string> = {};
        setBulkProductionBusy("prompts");
        const voiceDone = new Set<string>();
        const forks = new Map<string, any>();
        try {
            for (const initial of selected) {
                let asset = initial;
                if (asset.source === "global") {
                    const forked = forks.get(asset.id) || await api.forkAssetFromLibrary(currentProject.id, asset.kind, asset.id);
                    forks.set(asset.id, forked);
                    asset = { ...asset, id: forked.id, source: "episode", imagePrompt: forked.image_prompt || "", voice: forked.voice_design || {} };
                    remapped[initial.key] = assetTaskKey(currentProject.id, asset.id, asset.lookId);
                }
                if (!asset.imagePrompt) {
                    await api.generateProductionAssetPrompt(currentProject.id, asset.id, asset.lookId);
                    await waitForProductionAssetPrompt(currentProject.id, asset.id, asset.kind, updateProject, asset.lookId);
                }
                if (asset.kind === "character" && !voiceDone.has(asset.id) && !VOICE_KEYS.every((key) => asset.voice?.[key]?.trim())) {
                    const task = await api.generateProductionVoiceDesign(currentProject.id, asset.id);
                    await waitForProductionVoiceDesign(currentProject.id, asset.id, task.task_id, updateProject);
                    voiceDone.add(asset.id);
                }
            }
            updateProject(currentProject.id, await api.getProject(currentProject.id));
            toast.success("所选资产提示词与缺失的角色九维声音档案已生成", { body: "内容已保存，可在各资产工作台中继续编辑。" });
        } catch (error) {
            const detail = (error as { response?: { data?: { detail?: unknown } } })?.response?.data?.detail;
            toast.error("批量生成未完成", { body: typeof detail === "string" ? detail : error instanceof Error ? error.message : String(error) });
        } finally {
            setSelectedProductionAssets((ids) => ids.map((id) => remapped[id] || id));
            setBulkProductionBusy("");
        }
    };
    const generateSelectedImages = async () => {
        if (!currentProject) return;
        const selected = productionAssets.filter((item) => selectedProductionAssets.includes(item.key) && !item.locked && !item.hasImage);
        if (!selected.length) { toast.warning("所选资产均已有参考图或已锁定"); return; }
        const remapped: Record<string, string> = {};
        setBulkProductionBusy("images");
        let queued = 0;
        const forks = new Map<string, any>();
        try {
            for (let asset of selected) {
                if (asset.source === "global") {
                    const originalId = asset.key;
                    const forked = forks.get(asset.id) || await api.forkAssetFromLibrary(currentProject.id, asset.kind, asset.id);
                    forks.set(asset.id, forked);
                    asset = { ...asset, id: forked.id, source: "episode", imagePrompt: forked.image_prompt || "" };
                    remapped[originalId] = assetTaskKey(currentProject.id, asset.id, asset.lookId);
                }
                if (!asset.imagePrompt.trim()) throw new Error(`请先为“${asset.name}”生成资产提示词`);
                const result = await api.generateAsset(
                    currentProject.id, asset.id, asset.kind, currentProject.style_preset || "realistic",
                    currentProject.art_direction?.style_config?.positive_prompt || "",
                    asset.kind === "character" ? "reference_sheet" : "all", asset.imagePrompt, true,
                    currentProject.art_direction?.style_config?.negative_prompt || "", 1,
                    currentProject.production_settings?.image_model, currentProject.production_settings?.aspect_ratio,
                    asset.lookId,
                );
                const taskId = result?._task_id;
                if (!taskId) throw new Error(`“${asset.name}”没有返回图片任务编号`);
                addGeneratingTask(assetTaskKey(currentProject.id, asset.id, asset.lookId), asset.kind === "character" ? "reference_sheet" : "all", 1);
                startAssetPoll(asset.id, taskId, currentProject.id, asset.kind, asset.kind === "character" ? "reference_sheet" : "all", tWorkbench, () => ({
                    updateProject: useProjectStore.getState().updateProject,
                    removeGeneratingTask: useProjectStore.getState().removeGeneratingTask,
                }), undefined, asset.lookId);
                queued += 1;
            }
            if (queued) toast.success(`已提交 ${queued} 个资产图片任务`, { body: "每个任务完成后会保留候选图，人工确认后再进入分段。" });
        } catch (error) {
            toast.error("图片任务提交未完成", { body: error instanceof Error ? error.message : String(error) });
        } finally {
            setSelectedProductionAssets((ids) => ids.map((id) => remapped[id] || id));
            updateProject(currentProject.id, await api.getProject(currentProject.id).catch(() => currentProject));
            setBulkProductionBusy("");
        }
    };
    const syncDescriptions = async () => {
        if (!currentProject || !window.confirm("将剧本实体描述同步到本项目资产；不会覆盖参考图和视频。继续吗？")) return;
        try {
            updateProject(currentProject.id, await api.syncDescriptions(currentProject.id));
            toast.success("资产描述已同步");
        } catch (error) {
            toast.error("描述同步失败", { body: error instanceof Error ? error.message : String(error) });
        }
    };

    return (
        <div className="flex h-full w-full flex-col overflow-hidden">
            <StepPageHeader
                stepNumber={3}
                englishName="CAST"
                title={production ? "资产库" : tStep("castTitle")}
                subtitle={production ? "管理本项目的角色、场景与道具" : tStep("castSubtitle")}
                pills={!production && totalCast > 0 ? (
                    <>
                        <StepPill label={t("charactersLabel")} value={characters.length} />
                        <StepPill
                            label={t("referenceBoundLabel")}
                            value={(currentProject?.characters ?? []).filter((c: any) => c.reference_audio_url).length}
                        />
                    </>
                ) : null}
                trailing={<div className="flex items-center gap-2">{production && <WorkflowActionButton size="sm" variant="secondary" loading={productionAssetBusy === "preview"} onClick={() => void previewProductionAssets()}>从工程剧本提取</WorkflowActionButton>}{production && currentProject?.series_id && <ReconcileAction scriptId={currentProject.id} onApplied={() => { void api.getProject(currentProject.id).then((fresh) => updateProject(currentProject.id, fresh)); }} />}{production && <WorkflowActionButton size="sm" variant="secondary" onClick={() => void syncDescriptions()}>同步描述</WorkflowActionButton>}{!production && <ReconcileAction scriptId={currentProject?.id ?? null} />}</div>}
            />

            {productionPreview && <div className="mx-6 mt-4 rounded-xl border border-primary/25 bg-primary/5 p-4">
                <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-sm font-semibold">资产提取预览</h2><p className="mt-1 text-xs text-text-muted">确认后只新增或复用资产并同步镜头绑定；不会覆盖你已有的系列资产。</p></div><div className="flex gap-2"><WorkflowActionButton size="sm" variant="secondary" onClick={() => setProductionPreview(null)}>取消</WorkflowActionButton><WorkflowActionButton size="sm" variant="primary" loading={productionAssetBusy === "apply"} onClick={() => void applyProductionAssets()}>确认采用</WorkflowActionButton></div></div>
                <ProductionExtractionPreview preview={productionPreview} onChange={setProductionPreview} />
            </div>}

            {production && productionAssets.length > 0 && <details className="mx-6 mt-4 rounded-xl border border-glass-border bg-glass px-4 py-3">
                <summary className="cursor-pointer list-none text-xs font-medium text-text-secondary">批量生成与管理 <span className="ml-2 text-text-muted">已选 {selectedProductionAssets.length} / {productionAssets.length}</span></summary>
                <div className="mt-3 flex flex-wrap items-center justify-between gap-3"><p className="text-xs text-text-muted">只补充缺失项，不覆盖锁定资产和已采用参考图。</p><div className="flex flex-wrap gap-2"><WorkflowActionButton size="sm" variant="secondary" disabled={!!bulkProductionBusy || !selectedProductionAssets.length} loading={bulkProductionBusy === "prompts"} onClick={() => void generateSelectedPrompts()}>生成提示词与角色声音</WorkflowActionButton><WorkflowActionButton size="sm" variant="primary" disabled={!!bulkProductionBusy || !selectedProductionAssets.length} loading={bulkProductionBusy === "images"} onClick={() => void generateSelectedImages()}>生成缺失资产图</WorkflowActionButton></div></div>
                <div className="mt-3 flex items-center gap-3"><button className="text-xs text-primary hover:underline" onClick={() => setSelectedProductionAssets(productionAssets.filter((item) => !item.locked && (!item.imagePrompt || (item.kind === "character" && !VOICE_KEYS.every((key) => (item.voice as any)?.[key]?.trim())))).map((item) => item.key))}>选择缺失提示词／声音的资产</button></div>
                <div className="mt-2 grid max-h-44 gap-1 overflow-auto sm:grid-cols-2 xl:grid-cols-3">{productionAssets.map((item) => <label key={item.key} className="flex min-w-0 items-center gap-2 rounded px-2 py-1.5 text-xs text-text-secondary hover:bg-hover-bg"><input type="checkbox" checked={selectedProductionAssets.includes(item.key)} onChange={(event) => setSelectedProductionAssets((ids) => event.target.checked ? (ids.includes(item.key) ? ids : ids.concat(item.key)) : ids.filter((id) => id !== item.key))} /><span className="truncate">{item.kind === "character" ? "角色" : item.kind === "scene" ? "场景" : "道具"} · {item.name}</span><span className="ml-auto shrink-0 text-text-muted">{item.locked ? "锁定" : item.hasImage ? "有图" : "缺图"}</span></label>)}</div>
            </details>}

            {/* Empty state — no entities extracted yet */}
            {totalCast === 0 ? (
                <div className="flex flex-1 items-center justify-center bg-surface">
                    <div className="max-w-md text-center">
                        <div className="mb-4 inline-flex h-16 w-16 items-center justify-center rounded-full border border-glass-border bg-glass">
                            <Sparkles size={24} className="text-text-muted" />
                        </div>
                        <h3 className="font-display text-display font-medium text-foreground">
                            {t("emptyTitle")}
                        </h3>
                        <p className="mt-2 text-sm text-text-secondary leading-relaxed">
                            {t("emptyBody")}
                        </p>
                    </div>
                </div>
            ) : (
                <>
                    {/* Tab bar — '全部' is the default so users coming in fresh see
                        the full inventory before filtering down. Counts are
                        always visible so empty kinds telegraph themselves. */}
                    <div className="shrink-0 flex items-center gap-1 px-6 pt-3 border-b border-glass-border bg-surface">
                        {([
                            { id: "all" as const, label: t("tabAll"), icon: <Layers size={11} />, count: totalCast },
                            { id: "character" as const, label: t("tabCharacters"), icon: <Users size={11} />, count: characters.length },
                            { id: "scene" as const, label: t("tabScenes"), icon: <MapPin size={11} />, count: scenes.length },
                            { id: "prop" as const, label: t("tabProps"), icon: <Box size={11} />, count: props.length },
                        ]).filter((tab) => !production || tab.id !== "all").map((tab) => (
                            <button
                                key={tab.id}
                                onClick={() => setActiveTab(tab.id)}
                                className={`relative inline-flex items-center gap-1.5 px-3 pb-2 font-mono text-[0.6875rem] uppercase tracking-[0.16em] transition-colors ${
                                    visibleTab === tab.id
                                        ? "text-foreground"
                                        : "text-text-muted hover:text-text-secondary"
                                }`}
                            >
                                {tab.icon}
                                {tab.label}
                                <span className={`ml-0.5 ${visibleTab === tab.id ? "text-foreground" : "text-text-muted/60"}`}>
                                    ({tab.count})
                                </span>
                                {visibleTab === tab.id && (
                                    <span className="absolute bottom-0 left-2 right-2 h-px bg-primary" aria-hidden="true" />
                                )}
                            </button>
                        ))}
                    </div>

                    <div className="flex-1 overflow-y-auto bg-surface px-8 py-6 space-y-10 custom-scrollbar">
                        {(visibleTab === "all" || visibleTab === "character") && (
                            <CastSection
                                kind="character"
                                icon={<Users size={14} />}
                                title={t("sectionCharacters")}
                                items={characters}
                                emptyLabel={t("sectionEmptyCharacters")}
                                onAddNew={() => setAddModalOpen("character")}
                                addLabel={t("addCharacter")}
                                groupByPersona
                                onOpenWorkbench={(id) => setWorkbench({ kind: "character", entityId: id })}
                                hideHeader={visibleTab === "character"}
                                production={production}
                            />
                        )}
                        {(visibleTab === "all" || visibleTab === "scene") && (
                            <CastSection
                                kind="scene"
                                icon={<MapPin size={14} />}
                                title={t("sectionScenes")}
                                items={scenes}
                                emptyLabel={t("sectionEmptyScenes")}
                                onAddNew={() => setAddModalOpen("scene")}
                                addLabel={t("addScene")}
                                onOpenWorkbench={(id) => setWorkbench({ kind: "scene", entityId: id })}
                                hideHeader={visibleTab === "scene"}
                                production={production}
                            />
                        )}
                        {(visibleTab === "all" || visibleTab === "prop") && (
                            <CastSection
                                kind="prop"
                                icon={<Box size={14} />}
                                title={t("sectionProps")}
                                items={props}
                                emptyLabel={t("sectionEmptyProps")}
                                onAddNew={() => setAddModalOpen("prop")}
                                addLabel={t("addProp")}
                                onOpenWorkbench={(id) => setWorkbench({ kind: "prop", entityId: id })}
                                hideHeader={visibleTab === "prop"}
                                production={production}
                            />
                        )}
                    </div>
                </>
            )}

            {/* Workbench — per-entity generate / pick reference image */}
            <CastWorkbenchModal
                isOpen={workbench !== null}
                kind={workbench?.kind ?? null}
                entityId={workbench?.entityId ?? null}
                onClose={() => setWorkbench(null)}
                onEntityForked={(entityId) => setWorkbench((current) => current ? { ...current, entityId } : current)}
            />

            {/* R2V v2 Phase 5 — real Add new cast modal (AI / upload tabs). */}
            <AddCastPlaceholderModal
                kind={addModalOpen}
                seriesId={currentProject?.series_id ?? null}
                onClose={() => setAddModalOpen(null)}
                onCreated={() => {
                    // Trigger a project refresh by re-selecting; simplest
                    // way to surface the new series asset in this episode.
                    if (currentProject?.id) {
                        useProjectStore.getState().selectProject(currentProject.id);
                    }
                }}
            />
        </div>
    );
}

// R2V v2 Phase 5 — real "+ 新素材" modal.
// Two-tab UX: AI generate vs upload image. Both paths POST to
// /series/{id}/{kind} with a name/persona/description payload + optional
// image_url for upload. AI generation is a placeholder hand-off (creates
// the asset blank, then user can trigger generation from the card detail
// view) — full async generation queue ships when generation pipeline
// supports series-scope without project context.
function AddCastPlaceholderModal({
    kind,
    seriesId,
    onClose,
    onCreated,
}: {
    kind: null | "character" | "scene" | "prop";
    seriesId: string | null;
    onClose: () => void;
    onCreated: () => void;
}) {
    const t = useTranslations("cast");
    const [tab, setTab] = useState<"ai" | "upload">("ai");
    const [name, setName] = useState("");
    const [persona, setPersona] = useState("");
    const [description, setDescription] = useState("");
    const [uploading, setUploading] = useState(false);
    const [imageUrl, setImageUrl] = useState<string>("");
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // Reset state when modal closes / kind changes
    const reset = () => {
        setName(""); setPersona(""); setDescription("");
        setImageUrl(""); setError(null); setTab("ai");
    };

    if (!kind) return null;
    const label = kind === "character" ? t("sectionCharacters")
        : kind === "scene" ? t("sectionScenes")
        : t("sectionProps");

    const handleUpload = async (file: File) => {
        if (!file) return;
        setUploading(true);
        setError(null);
        try {
            const result = await api.uploadFile(file);
            setImageUrl(result.url || "");
        } catch (err: any) {
            setError(err?.response?.data?.detail || err?.message || "Upload failed");
        } finally {
            setUploading(false);
        }
    };

    const handleSubmit = async () => {
        if (!seriesId) {
            setError(t("seriesRequired"));
            return;
        }
        if (!name.trim()) {
            setError(t("nameRequired"));
            return;
        }
        setSubmitting(true);
        setError(null);
        try {
            const kindMap = { character: "characters", scene: "scenes", prop: "props" } as const;
            await api.createSeriesAsset(seriesId, kindMap[kind], {
                name: name.trim(),
                description: description.trim() || undefined,
                persona: kind === "character" ? (persona.trim() || undefined) : undefined,
                image_url: imageUrl || undefined,
            });
            onCreated();
            reset();
            onClose();
        } catch (err: any) {
            setError(err?.response?.data?.detail || err?.message || "Create failed");
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <div className="fixed inset-0 z-[100] grid place-items-center bg-overlay backdrop-blur-sm" onClick={() => { reset(); onClose(); }}>
            <div
                className="w-full max-w-md rounded-2xl border border-glass-border bg-elevated p-6 shadow-[0_24px_64px_-12px_rgba(0,0,0,0.7)]"
                onClick={e => e.stopPropagation()}
            >
                <div className="flex items-start gap-3 mb-4">
                    <div className="grid h-9 w-9 place-items-center rounded-full border border-primary/40 bg-primary/10 text-primary">
                        <Plus size={16} />
                    </div>
                    <div className="flex-1">
                        <h3 className="font-display text-display font-medium text-foreground">
                            {t("addModalTitle", { kind: label })}
                        </h3>
                        <p className="text-xs text-text-secondary mt-1">{t("addModalSubtitle")}</p>
                    </div>
                    <button onClick={() => { reset(); onClose(); }} className="p-2 hover:bg-hover-bg rounded-lg text-text-muted hover:text-foreground transition-colors">
                        <X size={16} />
                    </button>
                </div>

                {/* Tab switcher */}
                <div className="flex gap-1 mb-4 p-1 rounded-lg border border-glass-border bg-glass">
                    <button
                        onClick={() => setTab("ai")}
                        className={`flex-1 py-2 px-3 rounded-md text-sm font-medium transition-colors flex items-center justify-center gap-2 ${
                            tab === "ai" ? "bg-primary/15 text-primary" : "text-text-secondary hover:text-foreground"
                        }`}
                    >
                        <Sparkles size={14} />
                        {t("addTabAi")}
                    </button>
                    <button
                        onClick={() => setTab("upload")}
                        className={`flex-1 py-2 px-3 rounded-md text-sm font-medium transition-colors flex items-center justify-center gap-2 ${
                            tab === "upload" ? "bg-primary/15 text-primary" : "text-text-secondary hover:text-foreground"
                        }`}
                    >
                        <Upload size={14} />
                        {t("addTabUpload")}
                    </button>
                </div>

                {/* Common fields */}
                <div className="space-y-3">
                    <div>
                        <label className="block text-xs font-medium text-text-secondary mb-1.5">{t("fieldName")} *</label>
                        <input
                            type="text"
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                            placeholder={t("fieldNamePlaceholder")}
                            className="w-full bg-input-bg border border-glass-border rounded-lg px-3 py-2 text-sm text-foreground placeholder-text-muted focus:outline-none focus:border-primary"
                            autoFocus
                        />
                    </div>
                    {kind === "character" && (
                        <>
                            <div>
                                <label className="block text-xs font-medium text-text-secondary mb-1.5">
                                    {t("fieldPersona")} <span className="text-text-muted">({t("fieldPersonaHint")})</span>
                                </label>
                                <input
                                    type="text"
                                    value={persona}
                                    onChange={(e) => setPersona(e.target.value)}
                                    placeholder={t("fieldPersonaPlaceholder")}
                                    className="w-full bg-input-bg border border-glass-border rounded-lg px-3 py-2 text-sm text-foreground placeholder-text-muted focus:outline-none focus:border-primary"
                                />
                            </div>
                        </>
                    )}
                    <div>
                        <label className="block text-xs font-medium text-text-secondary mb-1.5">{t("fieldDescription")}</label>
                        <textarea
                            value={description}
                            onChange={(e) => setDescription(e.target.value)}
                            placeholder={tab === "ai" ? t("fieldDescriptionAiPlaceholder") : t("fieldDescriptionPlaceholder")}
                            rows={3}
                            className="w-full bg-input-bg border border-glass-border rounded-lg px-3 py-2 text-sm text-foreground placeholder-text-muted focus:outline-none focus:border-primary resize-none"
                        />
                    </div>

                    {/* Upload tab — file dropzone + preview */}
                    {tab === "upload" && (
                        <div>
                            <label className="block text-xs font-medium text-text-secondary mb-1.5">{t("fieldImageUpload")}</label>
                            {imageUrl ? (
                                <div className="relative">
                                    <PreviewImage src={imageUrl} className="w-full aspect-video rounded-lg" />
                                    <button
                                        onClick={() => setImageUrl("")}
                                        className="absolute top-2 right-2 p-1.5 bg-overlay rounded-md text-text-secondary hover:text-foreground transition-colors"
                                    >
                                        <X size={12} />
                                    </button>
                                </div>
                            ) : (
                                <label className="block w-full aspect-video rounded-lg border-2 border-dashed border-glass-border hover:border-primary/40 cursor-pointer transition-colors">
                                    <input
                                        type="file"
                                        accept="image/*"
                                        onChange={(e) => e.target.files?.[0] && handleUpload(e.target.files[0])}
                                        className="hidden"
                                        disabled={uploading}
                                    />
                                    <div className="h-full flex flex-col items-center justify-center text-text-muted">
                                        {uploading ? (
                                            <Loader2 size={20} className="animate-spin" />
                                        ) : (
                                            <>
                                                <Upload size={20} />
                                                <span className="mt-2 text-xs">{t("clickToUpload")}</span>
                                            </>
                                        )}
                                    </div>
                                </label>
                            )}
                        </div>
                    )}

                    {/* AI tab hint */}
                    {tab === "ai" && (
                        <div className="rounded-lg bg-primary/[0.06] border border-primary/20 px-3 py-2.5">
                            <p className="text-[0.71875rem] text-text-secondary leading-relaxed">
                                {t("aiTabHint")}
                            </p>
                        </div>
                    )}

                    {error && (
                        <div className="rounded-lg border border-status-failed-border/40 bg-status-failed-bg/50 px-3 py-2 text-status-failed-fg text-xs">
                            {error}
                        </div>
                    )}
                </div>

                {/* Actions */}
                <div className="flex gap-2 mt-5">
                    <WorkflowActionButton variant="ghost" size="sm" onClick={() => { reset(); onClose(); }} className="flex-1">
                        {t("cancel")}
                    </WorkflowActionButton>
                    <WorkflowActionButton
                        variant="primary"
                        size="sm"
                        loading={submitting}
                        onClick={handleSubmit}
                        disabled={!name.trim() || !seriesId}
                        className="flex-1"
                    >
                        {tab === "ai" ? t("createAndGenerate") : t("create")}
                    </WorkflowActionButton>
                </div>
            </div>
        </div>
    );
}

interface CastSectionProps {
    kind: AssetKind;
    icon: React.ReactNode;
    title: string;
    items: CastItem[];
    emptyLabel: string;
    onAddNew?: () => void;
    addLabel?: string;
    /** P1-a: when true, characters with shared `persona` cluster under
     *  a sub-header showing the persona label (only applies when at
     *  least one item has a non-empty persona). */
    groupByPersona?: boolean;
    /** Cast redesign — clicking a card (or its empty CTA) launches the
     *  per-entity generation workbench in the parent. */
    onOpenWorkbench?: (entityId: string) => void;
    /** When the parent's tab filter is already focused on this kind,
     *  the section's own header becomes redundant — hide it. */
    hideHeader?: boolean;
    production?: boolean;
}

function CastSection({ kind, icon, title, items, emptyLabel, onAddNew, addLabel, groupByPersona, onOpenWorkbench, hideHeader, production }: CastSectionProps) {
    const t = useTranslations("cast");
    // R2V v2 P1-a — persona grouping (characters only)
    const groups = useMemo(() => {
        if (!groupByPersona) return null;
        // Items with persona cluster under that key; persona-less stay solo
        const buckets = new Map<string, CastItem[]>();
        const ungrouped: CastItem[] = [];
        for (const item of items) {
            const p = (item.persona ?? "").trim();
            if (p) {
                const arr = buckets.get(p) ?? [];
                arr.push(item);
                buckets.set(p, arr);
            } else {
                ungrouped.push(item);
            }
        }
        // Multi-member groups only — single-member personas inline back
        const out: Array<{ persona: string | null; items: CastItem[] }> = [];
        const single: CastItem[] = [...ungrouped];
        for (const [p, arr] of Array.from(buckets.entries())) {
            if (arr.length >= 2) out.push({ persona: p, items: arr });
            else single.push(...arr);
        }
        // Sort: groups (by persona name), then ungrouped
        out.sort((a, b) => (a.persona ?? "").localeCompare(b.persona ?? ""));
        if (single.length) out.push({ persona: null, items: single });
        return out;
    }, [items, groupByPersona]);

    // Per-kind layout: characters portrait 3:4 + denser, scenes landscape
    // 16:9 + roomier, props 1:1 + densest. Matches each kind's natural
    // composition habit (portrait for people, landscape for environments,
    // square for objects) so thumbs don't letterbox.
    const gridCols = kind === "scene"
        ? "grid-cols-1 sm:grid-cols-2 lg:grid-cols-3"
        : kind === "character"
            ? "grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5"
            : "grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6";
    return (
        <section>
            {!hideHeader && (
                <header className="mb-3 flex items-center gap-2">
                    <span className="grid h-6 w-6 place-items-center rounded text-text-muted">{icon}</span>
                    <h3 className="font-mono text-[0.6875rem] font-medium uppercase tracking-[0.18em] text-text-secondary">
                        {title}
                    </h3>
                    <span className="font-mono text-[0.625rem] text-text-muted">({items.length})</span>
                    <div aria-hidden="true" className="ml-3 h-px flex-1 bg-glass-border" />
                    {onAddNew && (
                        <WorkflowActionButton
                            variant="ghost"
                            size="sm"
                            leftIcon={<Plus />}
                            onClick={onAddNew}
                        >
                            {addLabel}
                        </WorkflowActionButton>
                    )}
                </header>
            )}
            {hideHeader && onAddNew && (
                <div className="mb-3 flex items-center justify-end">
                    <WorkflowActionButton variant="ghost" size="sm" leftIcon={<Plus />} onClick={onAddNew}>
                        {addLabel}
                    </WorkflowActionButton>
                </div>
            )}
            {items.length === 0 ? (
                <p className="font-sans text-[0.78125rem] text-text-muted italic px-1">{emptyLabel}</p>
            ) : groups && groups.some(g => g.persona) ? (
                <div className="space-y-4">
                    {groups.map((group) => (
                        <div key={group.persona ?? "_solo"}>
                            {group.persona && (
                                <div className="flex items-center gap-2 mb-2 px-1">
                                    <span className="inline-flex items-center gap-1.5 font-mono text-[0.625rem] font-medium uppercase tracking-[0.16em] text-pink-300/90 bg-pink-300/10 px-2 py-0.5 rounded">
                                        <Users size={10} /> {t("personaGroup", { persona: group.persona })}
                                    </span>
                                    <span className="font-mono text-[0.625rem] text-text-muted">
                                        {t("personaGroupCount", { count: group.items.length })}
                                    </span>
                                </div>
                            )}
                            <div className={`grid gap-3 ${gridCols}`}>
                                {group.items.map(item => <CastCard key={item.id} item={item} production={production} onOpenWorkbench={() => onOpenWorkbench?.(item.id)} />)}
                            </div>
                        </div>
                    ))}
                </div>
            ) : (
                <div className={`grid gap-3 ${gridCols}`}>
                    {items.map(item => <CastCard key={item.id} item={item} production={production} onOpenWorkbench={() => onOpenWorkbench?.(item.id)} />)}
                </div>
            )}
        </section>
    );
}

function CastCard({ item, onOpenWorkbench, production }: { item: CastItem; onOpenWorkbench?: () => void; production?: boolean }) {
    const t = useTranslations("cast");
    const { open: openLightbox } = useLightbox();
    const updateProject = useProjectStore((state) => state.updateProject);
    const currentProject = useProjectStore((state) => state.currentProject);
    const generatingTasks = useProjectStore((state) => state.generatingTasks);
    const isGenerating = generatingTasks.some((task) => task.assetId === item.id);
    const [historyOpen, setHistoryOpen] = useState(false);

    // 参考音是这个角色唯一的“声音实物”（音色选择已在 2026-09-17 收掉 —— 产品只有
    // 韭菜盒子 seed-audio 一个音频通道，它不注册音色）。
    const character = item.kind === "character"
        ? currentProject?.characters?.find((c: any) => c.id === item.id)
        : null;
    const referenceUrl: string | undefined = character?.reference_audio_url;

    // Per-kind visual treatment WITHOUT bulk color fills (per impeccable
    // product register: 'Heavy color or full-saturation accents on inactive
    // states' is banned). Differentiation is carried by:
    //   1. Aspect ratio (already in section grid + the `aspect` class)
    //   2. A subtle CSS pattern on the empty thumb (hairlines for character,
    //      horizon for scene, dot grid for prop) — all in 3-6% white
    //   3. A small mono-caps kind chip top-right with hairline border
    //   4. Hover only: a quiet 1px top-edge hairline in the kind tint
    // No saturated background fills anywhere. Color only appears on hover
    // (an active state) and on the kind chip (which is itself near-mono).
    const kindStyles: Record<AssetKind, {
        aspect: string;
        emptyPattern: React.CSSProperties;
        chipLabel: string;
        hoverAccent: string;
        watermarkIcon: React.ReactNode;
        ctaIcon: React.ReactNode;
        ctaLabel: string;
    }> = {
        character: {
            aspect: production ? "aspect-[3/4]" : "aspect-[4/3]",
            emptyPattern: {
                backgroundImage:
                    "repeating-linear-gradient(0deg, transparent 0, transparent 23px, rgba(255,255,255,0.025) 23px, rgba(255,255,255,0.025) 24px)",
            },
            chipLabel: t("tabCharacters"),
            hoverAccent: "rgba(167,139,250,0.55)",
            watermarkIcon: <Users size={48} className="text-text-muted" strokeWidth={1} />,
            ctaIcon: <Wand2 size={22} strokeWidth={1.75} />,
            ctaLabel: t("generateReference"),
        },
        scene: {
            aspect: "aspect-[16/9]",
            emptyPattern: {
                backgroundImage: [
                    "linear-gradient(to bottom, transparent calc(33% - 0.5px), rgba(255,255,255,0.03) 33%, transparent calc(33% + 0.5px))",
                    "linear-gradient(to bottom, transparent calc(66% - 0.5px), rgba(255,255,255,0.05) 66%, transparent calc(66% + 0.5px))",
                ].join(", "),
            },
            chipLabel: t("tabScenes"),
            hoverAccent: "rgba(110,231,183,0.5)",
            watermarkIcon: <MapPin size={64} className="text-text-muted" strokeWidth={0.75} />,
            ctaIcon: <Sparkles size={22} strokeWidth={1.75} />,
            ctaLabel: t("generateScene"),
        },
        prop: {
            aspect: "aspect-square",
            emptyPattern: {
                backgroundImage:
                    "radial-gradient(rgba(255,255,255,0.04) 0.8px, transparent 0.8px)",
                backgroundSize: "10px 10px",
                backgroundPosition: "5px 5px",
            },
            chipLabel: t("tabProps"),
            hoverAccent: "rgba(252,211,77,0.5)",
            watermarkIcon: <Box size={40} className="text-text-muted" strokeWidth={1} />,
            ctaIcon: <Layers size={22} strokeWidth={1.75} />,
            ctaLabel: t("generateProp"),
        },
    };
    const k = kindStyles[item.kind];

    const cardRadius = item.kind === "scene" ? "rounded-md" : "rounded-lg";

    return (
        <>
            <div
                className={`group/cast-card relative flex flex-col gap-2 ${cardRadius} border border-glass-border bg-glass p-2 transition-[border-color,background-color] duration-fast ease-out-quart hover:border-foreground/30`}
            >
                {/* Kind chip — top-right, near-mono. Sits on TOP of the thumb
                    so it works for both empty and ready states without
                    occluding the image (small + corner-tucked). */}
                <span className="absolute top-2.5 right-2.5 z-10 pointer-events-none inline-flex items-center rounded-sm border border-glass-border bg-black/40 px-1.5 py-[1px] font-mono text-[0.53125rem] uppercase tracking-[0.18em] text-text-muted backdrop-blur-sm">
                    {k.chipLabel}
                </span>
                {production && (item.source === "series" || item.source === "global") && <span className="absolute left-2.5 top-2.5 z-10 rounded-full border border-primary/30 bg-black/55 px-2 py-0.5 text-[0.625rem] text-primary backdrop-blur">{item.source === "series" ? "系列共享" : "全局共享"}</span>}
                {/* Hover hairline accent — single top edge, animated on group-hover */}
                <span
                    aria-hidden="true"
                    className="pointer-events-none absolute inset-x-2 top-0 h-px opacity-0 group-hover/cast-card:opacity-100 transition-opacity"
                    style={{ background: k.hoverAccent }}
                />
                <div
                    className={`${k.aspect} overflow-hidden rounded-md bg-black/40 relative cursor-pointer`}
                    onClick={() => item.referenceImageUrl && onOpenWorkbench?.()}
                >
                    {item.referenceImageUrl ? (
                        <>
                            <PreviewImage src={item.referenceImageUrl} alt={item.name} className="h-full w-full object-contain" noLightbox />
                            <button
                                onClick={(e) => {
                                    e.stopPropagation();
                                    openLightbox({ src: getAssetUrl(item.referenceImageUrl!), alt: item.name, kind: "image" });
                                }}
                                aria-label="放大查看"
                                title="放大查看"
                                className="absolute left-1.5 top-1.5 z-10 grid h-6 w-6 place-items-center rounded bg-black/55 text-foreground/80 backdrop-blur opacity-0 group-hover/cast-card:opacity-100 transition-opacity hover:bg-black/75"
                            >
                                <Maximize2 size={11} />
                            </button>
                        </>
                    ) : (
                        <button
                            onClick={() => onOpenWorkbench?.()}
                            className="relative grid h-full w-full place-items-center bg-black/20 text-text-secondary hover:text-foreground transition-colors overflow-hidden"
                            style={k.emptyPattern}
                        >
                            {item.kind === "scene" && (
                                <>
                                    <span className="pointer-events-none absolute inset-x-0 top-0 h-3 bg-gradient-to-b from-black/30 to-transparent" aria-hidden="true" />
                                    <span className="pointer-events-none absolute inset-x-0 bottom-0 h-3 bg-gradient-to-t from-black/30 to-transparent" aria-hidden="true" />
                                </>
                            )}
                            <CornerMarks />
                            <span className="relative flex flex-col items-center gap-2 z-10">
                                <span className="text-text-muted/70">{k.ctaIcon}</span>
                                <span className="text-[0.625rem] font-medium tracking-wide">{k.ctaLabel}</span>
                            </span>
                        </button>
                    )}
                    {isGenerating && (
                        <div className="absolute inset-0 z-20 grid place-items-center bg-black/60 backdrop-blur-sm rounded-md">
                            <div className="flex flex-col items-center gap-1.5">
                                <Loader2 size={20} className="animate-spin text-primary" />
                                <span className="text-[0.625rem] text-text-secondary">生成中...</span>
                            </div>
                        </div>
                    )}
                </div>
                <div className="space-y-1 px-0.5">
                    <p className="truncate font-sans text-[0.8125rem] font-medium text-foreground" title={item.name}>
                        {item.name}
                    </p>
                    {production && item.description && <p className="line-clamp-2 text-xs leading-5 text-text-muted">{item.description}</p>}
                    {production && !!item.looksCount && <p className="text-xs text-primary">{item.looksCount} 套造型</p>}
                    <div className="flex items-center justify-between gap-1">
                        <span className="font-mono text-[0.625rem] uppercase tracking-[0.12em] text-text-muted">
                            {t("appearancesCount", { count: item.appearances })}
                        </span>
                        <StatusBadge status={item.status} />
                    </div>
                </div>
                {/* P1-c — history (cross-episode appearances) trigger.
                    Only for characters in series-affiliated episodes. */}
                {item.kind === "character" && currentProject?.series_id && (
                    <button
                        onClick={() => setHistoryOpen(true)}
                        className="absolute top-1 right-1 p-1 rounded bg-overlay/0 text-text-muted opacity-0 group-hover/cast-card:opacity-100 hover:text-foreground hover:bg-overlay transition-all"
                        title={t("viewHistory")}
                    >
                        <Sparkles size={11} />
                    </button>
                )}
            </div>
            {historyOpen && currentProject?.series_id && (
                <CharacterHistoryPopover
                    seriesId={currentProject.series_id}
                    characterId={item.id}
                    onClose={() => setHistoryOpen(false)}
                />
            )}
        </>
    );
}

function CharacterHistoryPopover({ seriesId, characterId, onClose }: { seriesId: string; characterId: string; onClose: () => void }) {
    const t = useTranslations("cast");
    const [data, setData] = useState<any>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        api.getCharacterAppearances(seriesId, characterId)
            .then(d => { if (!cancelled) setData(d); })
            .catch(err => { if (!cancelled) setError(err?.response?.data?.detail || err?.message || "Load failed"); })
            .finally(() => { if (!cancelled) setLoading(false); });
        return () => { cancelled = true; };
    }, [seriesId, characterId]);

    return (
        <div className="fixed inset-0 z-[100] grid place-items-center bg-overlay backdrop-blur-sm" onClick={onClose}>
            <div
                className="w-full max-w-md rounded-2xl border border-glass-border bg-elevated p-6 shadow-[0_24px_64px_-12px_rgba(0,0,0,0.7)]"
                onClick={e => e.stopPropagation()}
            >
                <div className="flex items-start gap-3 mb-4">
                    <div className="grid h-9 w-9 place-items-center rounded-full border border-pink-400/40 bg-pink-400/10 text-pink-300">
                        <Sparkles size={16} />
                    </div>
                    <div className="flex-1 min-w-0">
                        <h3 className="font-display text-display font-medium text-foreground truncate">
                            {data?.character?.name || t("loading")}
                        </h3>
                        {data?.character?.persona && (
                            <p className="text-xs text-text-secondary mt-0.5">Persona · {data.character.persona}</p>
                        )}
                    </div>
                    <button onClick={onClose} className="p-2 hover:bg-hover-bg rounded-lg text-text-muted hover:text-foreground transition-colors">
                        <X size={16} />
                    </button>
                </div>
                {loading ? (
                    <div className="grid place-items-center py-8 text-text-muted"><Loader2 className="animate-spin" size={18} /></div>
                ) : error ? (
                    <p className="rounded-lg border border-status-failed-border/40 bg-status-failed-bg/50 px-3 py-2 text-status-failed-fg text-xs">{error}</p>
                ) : (
                    <div className="space-y-3">
                        <p className="text-xs text-text-secondary">
                            {t("totalAppearances", { count: data?.total_frames ?? 0, episodes: data?.appearances?.length ?? 0 })}
                        </p>
                        <div className="space-y-1.5 max-h-72 overflow-y-auto custom-scrollbar">
                            {(data?.appearances || []).map((app: any) => (
                                <div key={app.episode_id} className="flex items-center justify-between gap-3 px-3 py-2 rounded-lg border border-glass-border bg-glass">
                                    <div className="min-w-0 flex-1">
                                        <p className="text-sm font-medium text-foreground truncate">
                                            EP{app.episode_number ?? "?"} · {app.episode_title}
                                        </p>
                                    </div>
                                    <span className="font-mono text-[0.625rem] uppercase tracking-[0.12em] text-pink-300">
                                        {t("appearancesCount", { count: app.frame_count })}
                                    </span>
                                </div>
                            ))}
                            {data?.appearances?.length === 0 && (
                                <p className="text-center py-4 text-xs text-text-muted">{t("noAppearancesYet")}</p>
                            )}
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}

function CornerMarks() {
    const stroke = "rgba(255,255,255,0.12)";
    const size = 10;
    return (
        <>
            {/* TL */}
            <svg className="pointer-events-none absolute top-2 left-2" width={size} height={size} aria-hidden="true">
                <path d={`M0 ${size} V0 H${size}`} fill="none" stroke={stroke} strokeWidth="1" />
            </svg>
            {/* TR */}
            <svg className="pointer-events-none absolute top-2 right-2" width={size} height={size} aria-hidden="true">
                <path d={`M${size} ${size} V0 H0`} fill="none" stroke={stroke} strokeWidth="1" />
            </svg>
            {/* BL */}
            <svg className="pointer-events-none absolute bottom-2 left-2" width={size} height={size} aria-hidden="true">
                <path d={`M0 0 V${size} H${size}`} fill="none" stroke={stroke} strokeWidth="1" />
            </svg>
            {/* BR */}
            <svg className="pointer-events-none absolute bottom-2 right-2" width={size} height={size} aria-hidden="true">
                <path d={`M${size} 0 V${size} H0`} fill="none" stroke={stroke} strokeWidth="1" />
            </svg>
        </>
    );
}

function StatusBadge({ status }: { status: "ready" | "pending" | "new" }) {
    const t = useTranslations("cast");
    if (status === "ready") {
        return (
            <span className="inline-flex items-center rounded-full bg-[rgba(100,108,255,0.12)] px-1.5 py-0.5 font-mono text-[0.5625rem] font-medium uppercase tracking-wider text-primary">
                {t("statusReady")}
            </span>
        );
    }
    if (status === "pending") {
        return (
            <span className="inline-flex items-center gap-1 rounded-full bg-[rgba(245,158,11,0.12)] px-1.5 py-0.5 font-mono text-[0.5625rem] font-medium uppercase tracking-wider text-amber-400">
                <AlertTriangle size={9} aria-hidden="true" />
                {t("statusPending")}
            </span>
        );
    }
    return (
        <span className="inline-flex items-center gap-1 rounded-full bg-[rgba(236,72,153,0.14)] px-1.5 py-0.5 font-mono text-[0.5625rem] font-medium uppercase tracking-wider text-pink-400">
            🆕 {t("statusNew")}
        </span>
    );
}
