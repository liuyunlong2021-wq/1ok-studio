"use client";

import { useState } from "react";
import { useProjectStore } from "@/store/projectStore";
import { api } from "@/lib/api";
import { getAssetUrl } from "@/lib/utils";
import StepPageHeader from "@/components/shared/StepPageHeader";
import WorkflowActionButton from "@/components/shared/WorkflowActionButton";
import { toast } from "@/store/toastStore";

export default function ProductionAssemblyWorkbench() {
    const project = useProjectStore((state) => state.currentProject);
    const updateProject = useProjectStore((state) => state.updateProject);
    const [busy, setBusy] = useState(false);
    if (!project) return null;
    const segments = project.production_segments || [];
    const plannedSeconds = segments.reduce((total: number, segment: any) => total + (segment.duration_total || 0), 0);
    const selected = project.production_selected_video_tasks || {};
    const ready = segments.length > 0 && segments.every((segment: any) => {
        const task = (project.video_tasks || []).find((item: any) => item.id === selected[segment.id]);
        return !!segment.adopted_at && task?.status === "completed" && !!task.video_url && task.segment_id === segment.id && task.segment_revision === segment.revision;
    });
    const merge = async () => {
        setBusy(true);
        try {
            const result = await api.mergeVideos(project.id);
            updateProject(project.id, result);
            toast.success("整集合成完成");
        } catch (error) {
            const detail = (error as { response?: { data?: { detail?: unknown } } })?.response?.data?.detail;
            toast.error("整集合成失败", { body: typeof detail === "string" ? detail : error instanceof Error ? error.message : "请检查每段成片和 FFmpeg。" });
        } finally { setBusy(false); }
    };
    return <div className="flex h-full min-h-0 flex-col overflow-hidden">
        <StepPageHeader stepNumber={6} englishName="FINAL ASSEMBLY" title="整集合成" subtitle={`当前共 ${plannedSeconds} 秒；严格按分段顺序，只使用每段明确选中的成片；本流程不混入 BGM。`} />
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto bg-surface p-6">
            {segments.map((segment: any) => {
                const task = (project.video_tasks || []).find((item: any) => item.id === selected[segment.id]);
                return <div key={segment.id} className="flex items-center justify-between rounded-xl border border-glass-border bg-glass p-4"><div><p className="font-medium">第 {segment.index} 段 · {segment.duration_total}s</p><p className="mt-1 text-xs text-text-muted">{task ? `已选成片 · ${task.status}` : "尚未选择已完成的视频任务"}</p></div>{task?.video_url && <a href={getAssetUrl(task.video_url)} target="_blank" rel="noreferrer" className="text-xs text-primary underline">查看片段</a>}</div>;
            })}
            <div className="mt-auto flex items-center justify-between gap-4 rounded-xl border border-glass-border p-4"><span className="text-sm text-text-secondary">{project.merged_video_url ? "最近一次整集合成结果会保留，直到新合成成功。" : "需要所有分段均选定成片。"}</span><WorkflowActionButton variant="primary" loading={busy} disabled={busy || !ready} onClick={() => void merge()}>按顺序合成整集</WorkflowActionButton></div>
            {project.merged_video_url && <video className="max-h-[55vh] w-full rounded-xl bg-black" controls src={getAssetUrl(project.merged_video_url)} />}
        </div>
    </div>;
}
