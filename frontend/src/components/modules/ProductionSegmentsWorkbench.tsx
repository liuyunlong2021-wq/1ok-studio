"use client";

import { useState } from "react";
import { useProjectStore } from "@/store/projectStore";
import { api } from "@/lib/api";
import { getAssetUrl } from "@/lib/utils";
import StepPageHeader from "@/components/shared/StepPageHeader";
import WorkflowActionButton from "@/components/shared/WorkflowActionButton";
import { toast } from "@/store/toastStore";

const errorText = (error: unknown) => {
    const detail = (error as { response?: { data?: { detail?: unknown } } })?.response?.data?.detail;
    return typeof detail === "string" ? detail : error instanceof Error ? error.message : "操作失败，请重试。";
};

export default function ProductionSegmentsWorkbench() {
    const project = useProjectStore((state) => state.currentProject);
    const updateProject = useProjectStore((state) => state.updateProject);
    const [busy, setBusy] = useState("");
    if (!project) return null;
    const segments = project.production_segments || [];
    const plannedSeconds = segments.reduce((total: number, segment: any) => total + (segment.duration_total || 0), 0);
    const refresh = async () => updateProject(project.id, await api.getProject(project.id));
    const run = async (key: string, action: () => Promise<unknown>, message: string) => {
        setBusy(key);
        try { await action(); await refresh(); toast.success(message); }
        catch (error) { toast.error("分段操作失败", { body: errorText(error) }); }
        finally { setBusy(""); }
    };

    return <div className="flex h-full min-h-0 flex-col overflow-hidden">
        <StepPageHeader stepNumber={4} englishName="SEGMENTED SCREENPLAY" title="分段工程剧本" subtitle={`当前规划 ${segments.length} 段共 ${plannedSeconds} 秒；每段总长不超过 ${project.production_settings?.max_segment_seconds || "用户设置"} 秒，含最后 1 秒空间关系全景；镜头不会被切开。`} />
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto bg-surface p-6">
            <div className="flex items-center justify-between gap-3">
                <p className="text-sm text-text-secondary">检查每段简介、开场承接与结尾全景站位；保存后可采用整套分段。</p>
                <WorkflowActionButton size="sm" variant="secondary" loading={busy === "plan"} disabled={!!busy || !project.engineering_script} onClick={() => void run("plan", () => api.planProductionSegments(project.id), "分段方案已生成")}>重新按镜头分段</WorkflowActionButton>
            </div>
            {segments.length === 0 ? <p className="rounded-xl border border-glass-border p-8 text-center text-text-muted">先确认工程剧本并完成资产提取，再生成分段方案。</p> : <div className="space-y-4">
                {segments.map((segment: any) => <SegmentCard key={segment.id} segment={segment} projectId={project.id} busy={!!busy} onSaved={refresh} />)}
            </div>}
            {segments.length > 0 && <div className="flex justify-end">
                <WorkflowActionButton variant="primary" loading={busy === "adopt"} disabled={!!busy} onClick={() => void run("adopt", () => api.adoptProductionSegments(project.id), "全部分段已采用")}>校验并采用全部分段</WorkflowActionButton>
            </div>}
        </div>
    </div>;
}

function SegmentCard({ segment, projectId, busy, onSaved }: { segment: any; projectId: string; busy: boolean; onSaved: () => Promise<void> }) {
    const [synopsis, setSynopsis] = useState(segment.synopsis || "");
    const [entry, setEntry] = useState(segment.entry_state || "");
    const [exit, setExit] = useState(segment.exit_state || "");
    const [saving, setSaving] = useState(false);
    const update = async () => {
        setSaving(true);
        try {
            await api.updateProductionSegment(projectId, segment.id, { synopsis, entry_state: entry, exit_state: exit, segment_revision: segment.revision });
            await onSaved(); toast.success(`第 ${segment.index} 段已保存`);
        } catch (error) { toast.error("保存失败", { body: errorText(error) }); }
        finally { setSaving(false); }
    };
    const field = (label: string, value: string, change: (next: string) => void, hint: string) => <label className="block space-y-1"><span className="text-xs text-text-muted">{label}</span><textarea value={value} onChange={(e) => change(e.target.value)} placeholder={hint} disabled={busy} className="min-h-20 w-full resize-y rounded-lg border border-glass-border bg-input-bg p-3 text-sm text-foreground outline-none focus:border-primary/60 disabled:opacity-60" /></label>;
    return <section className="rounded-xl border border-glass-border bg-glass p-4">
        <div className="mb-3 flex items-center justify-between"><h2 className="font-medium">第 {segment.index} 段 · {segment.duration_story}s 剧情 + 1s 全景 / 共 {segment.duration_total}s</h2><span className="text-xs text-text-muted">来源镜头 {segment.source_shot_numbers?.join("、")}</span></div>
        <div className="grid gap-3 lg:grid-cols-3">
            {field("一句话分段简介（主体 + 人物关系 + 情绪 + 内容）", synopsis, setSynopsis, "例如：甲愤怒地咒骂妻子乙，乙默默承受。")}
            {field("本段开场承接状态", entry, setEntry, "人物站位、朝向、距离、视线、持物与机位关系")}
            {field("结尾 1 秒全景的相对位置", exit, setExit, "明确每个人相对位置，供下一段延续空间关系")}
        </div>
        {segment.asset_refs?.length > 0 && <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">{segment.asset_refs.map((asset: any) => <div key={`${asset.id}:${asset.look_id || ""}`} className="flex min-w-0 items-center gap-2 rounded-lg border border-glass-border p-2 text-xs"><div className="h-12 w-12 shrink-0 overflow-hidden rounded bg-black/20">{asset.image_url && <img src={getAssetUrl(asset.image_url)} alt={asset.name} className="h-full w-full object-cover" />}</div><div className="min-w-0"><p className="truncate font-medium">图{asset.number} · {asset.name}{asset.look_name ? ` · ${asset.look_name}` : ""}</p><p className="line-clamp-2 text-text-muted">{asset.description || "尚无资产提示词描述"}</p></div></div>)}</div>}
        <details className="mt-3"><summary className="cursor-pointer text-xs text-text-muted">查看四段式工程剧本与参考资产</summary><pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap rounded-lg bg-black/20 p-3 text-xs leading-5 text-text-secondary">{segment.screenplay_text}</pre></details>
        <div className="mt-3 flex justify-end"><WorkflowActionButton size="sm" variant="secondary" loading={saving} disabled={busy} onClick={() => void update()}>保存本段</WorkflowActionButton></div>
    </section>;
}
