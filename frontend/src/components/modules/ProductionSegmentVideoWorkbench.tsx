"use client";

import { useEffect, useState } from "react";
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

async function waitForSegmentPrompt(projectId: string, segmentId: string) {
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        const project = await api.getProject(projectId);
        useProjectStore.getState().updateProject(projectId, project);
        const segment = (project.production_segments || []).find((item: any) => item.id === segmentId);
        if (segment?.prompt_generation_status === "completed") return segment.prompt_draft || "";
        if (["failed", "stale"].includes(segment?.prompt_generation_status)) {
            throw new Error(segment.prompt_generation_error || "分段提示词生成失败");
        }
    }
    throw new Error("提示词仍在后台处理中；稍后可重新打开本段查看状态");
}

export default function ProductionSegmentVideoWorkbench() {
    const project = useProjectStore((state) => state.currentProject);
    const updateProject = useProjectStore((state) => state.updateProject);
    const [busy, setBusy] = useState("");
    const segments = project?.production_segments || [];
    const tasks = project?.video_tasks || [];
    const hasRunningTasks = tasks.some((task: any) => ["pending", "queued", "processing", "downloading"].includes(task.status));
    useEffect(() => {
        if (!project?.id || !hasRunningTasks) return;
        const timer = setInterval(() => {
            void api.getProject(project.id).then((fresh) => updateProject(project.id, fresh)).catch(() => {});
        }, 2500);
        return () => clearInterval(timer);
    }, [project?.id, hasRunningTasks, updateProject]);
    if (!project) return null;
    const refresh = async () => updateProject(project.id, await api.getProject(project.id));
    const run = async (key: string, action: () => Promise<unknown>, message: string) => {
        setBusy(key);
        try { await action(); await refresh(); toast.success(message); }
        catch (error) { toast.error("分段视频操作失败", { body: errorText(error) }); }
        finally { setBusy(""); }
    };
    return <div className="flex h-full min-h-0 flex-col overflow-hidden">
        <StepPageHeader stepNumber={5} englishName="SEGMENT VIDEO" title="分段视频" subtitle="提示词可编辑、采用后再提交。每段单独生成与选片，不会自动开跑。" />
        <div className="min-h-0 flex-1 space-y-4 overflow-auto bg-surface p-6">
            {segments.length === 0 && <p className="rounded-xl border border-glass-border p-8 text-center text-text-muted">请先采用分段工程剧本。</p>}
            {segments.map((segment: any) => <ProductionVideoSegment key={segment.id} segment={segment} tasks={tasks.filter((task: any) => task.segment_id === segment.id)} selectedTaskId={project.production_selected_video_tasks?.[segment.id]} busy={!!busy} onRun={run} projectId={project.id} onRefresh={refresh} />)}
        </div>
    </div>;
}

function ProductionVideoSegment({ segment, tasks, selectedTaskId, busy, onRun, projectId, onRefresh }: any) {
    const [prompt, setPrompt] = useState(segment.prompt_draft || segment.adopted_prompt || "");
    const selected = tasks.find((task: any) => task.id === selectedTaskId);
    return <section className="rounded-xl border border-glass-border bg-glass p-4">
        <div className="mb-3 flex items-center justify-between"><div><h2 className="font-medium">第 {segment.index} 段 · {segment.duration_total}s</h2><p className="mt-1 text-xs text-text-muted">{segment.synopsis || "未填写分段简介"}</p></div><span className="text-xs text-text-muted">{selected ? `已选片 · ${selected.status}` : `${tasks.length} 个候选`}</span></div>
        <div className="mb-3 flex flex-wrap gap-2">
            <WorkflowActionButton size="sm" variant="secondary" loading={busy || ["queued", "processing"].includes(segment.prompt_generation_status)} disabled={busy || !segment.adopted_at} onClick={() => void onRun(`prompt:${segment.id}`, async () => { await api.generateProductionSegmentPrompt(projectId, segment.id, segment.revision); setPrompt(await waitForSegmentPrompt(projectId, segment.id)); }, "提示词草稿已生成")}>{segment.prompt_generation_status === "processing" ? "提示词生成中…" : segment.prompt_generation_status === "queued" ? "提示词排队中…" : "按已选 Skill 生成提示词"}</WorkflowActionButton>
            <WorkflowActionButton size="sm" variant="secondary" loading={busy} disabled={busy || !prompt.trim()} onClick={() => void onRun(`save:${segment.id}`, async () => { await api.saveProductionSegmentPrompt(projectId, segment.id, prompt, segment.revision); }, "提示词草稿已保存")}>保存提示词</WorkflowActionButton>
            <WorkflowActionButton size="sm" variant="secondary" loading={busy} disabled={busy || !segment.prompt_draft?.trim() && !prompt.trim()} onClick={() => void onRun(`adopt:${segment.id}`, async () => { await api.adoptProductionSegmentPrompt(projectId, segment.id, prompt, segment.revision); }, "提示词已采用")}>采用提示词</WorkflowActionButton>
            <WorkflowActionButton size="sm" variant="primary" loading={busy} disabled={busy || !segment.adopted_prompt} onClick={() => void onRun(`video:${segment.id}`, () => api.createProductionSegmentVideo(projectId, segment.id, segment.revision), "视频任务已提交")}>提交本段视频</WorkflowActionButton>
        </div>
        <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="生成后检查并编辑视频提示词，再明确采用。" className="min-h-40 w-full resize-y rounded-lg border border-glass-border bg-input-bg p-3 font-mono text-xs leading-5 text-foreground outline-none focus:border-primary/60" />
        {tasks.length > 0 && <div className="mt-3 grid gap-2 md:grid-cols-2">{tasks.map((task: any) => <div key={task.id} className="flex items-center justify-between gap-3 rounded-lg border border-glass-border p-3 text-xs"><span>{task.status} · {task.duration}s · {task.model}</span><div className="flex gap-2">{task.video_url && <a className="text-primary underline" href={getAssetUrl(task.video_url)} target="_blank" rel="noreferrer">预览</a>}{task.status === "completed" && <button disabled={busy} onClick={() => void onRun(`select:${segment.id}`, () => api.selectProductionSegmentVideo(projectId, segment.id, task.id), "本段成片已选择")} className="text-emerald-300 disabled:opacity-50">{task.id === selectedTaskId ? "已选" : "选为成片"}</button>}</div></div>)}</div>}
    </section>;
}
