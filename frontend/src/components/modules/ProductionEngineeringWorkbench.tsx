"use client";

import { useEffect, useState } from "react";
import { useProjectStore } from "@/store/projectStore";
import { api } from "@/lib/api";
import StepPageHeader from "@/components/shared/StepPageHeader";
import WorkflowActionButton from "@/components/shared/WorkflowActionButton";
import { toast } from "@/store/toastStore";

function detailOf(error: unknown) {
    const detail = (error as { response?: { data?: { detail?: unknown } } })?.response?.data?.detail;
    return typeof detail === "string" ? detail : error instanceof Error ? error.message : "操作失败，请重试。";
}

async function waitForEngineeringTask(projectId: string, taskId: string) {
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        const project = await api.getProject(projectId);
        useProjectStore.getState().updateProject(projectId, project);
        const task = project.production_engineering_task;
        if (task?.task_id !== taskId) throw new Error("工程剧本任务版本已变化，请刷新后检查草稿状态");
        if (task.status === "completed") return project.production_engineering_draft?.text || "";
        if (["failed", "stale"].includes(task.status)) throw new Error(task.error || "工程剧本生成失败");
    }
    throw new Error("工程剧本仍在后台处理中；稍后可重新打开项目查看状态");
}

export default function ProductionEngineeringWorkbench() {
    const project = useProjectStore((state) => state.currentProject);
    const updateProject = useProjectStore((state) => state.updateProject);
    const [source, setSource] = useState("");
    const [screenplay, setScreenplay] = useState("");
    const [busy, setBusy] = useState<"" | "source" | "generate" | "adopt">("");

    useEffect(() => {
        if (!project) return;
        setSource(project.originalText || "");
        setScreenplay(project.production_engineering_draft?.text || "");
    }, [project?.id]);

    if (!project) return null;
    const currentPlan = project.engineering_script;
    const draftText = project.production_engineering_draft?.text || "";
    const hasManualEdits = !!screenplay.trim() && screenplay !== draftText;
    const isAdopted = !!currentPlan
        && project.production_engineering_source_revision === project.production_source_revision
        && project.production_engineering_style_revision === project.production_style_revision;

    const saveSource = async () => {
        setBusy("source");
        try {
            const updated = await api.updateScriptText(project.id, source);
            updateProject(project.id, updated);
            toast.success("原始剧本已保存");
        } catch (error) {
            toast.error("保存失败", { body: detailOf(error) });
            throw error;
        } finally {
            setBusy("");
        }
    };

    const generate = async () => {
        setBusy("generate");
        try {
            const saved = await api.updateScriptText(project.id, source);
            updateProject(project.id, saved);
            const task = await api.generateProductionEngineering(project.id);
            const generated = await waitForEngineeringTask(project.id, task.task_id);
            setScreenplay(generated);
            const updated = await api.adoptProductionEngineering(project.id, generated);
            updateProject(project.id, updated);
            toast.success("工程剧本已生成并按时间码解析", { body: "下一步进入资产提取；可在需要时手动修改并重新应用。" });
            document.dispatchEvent(new CustomEvent("1okstudio:navigateStep", { detail: "cast" }));
        } catch (error) {
            toast.error("生成或解析工程剧本失败", { body: detailOf(error) });
        } finally {
            setBusy("");
        }
    };

    const adopt = async () => {
        setBusy("adopt");
        try {
            await api.saveProductionEngineeringDraft(project.id, screenplay);
            const updated = await api.adoptProductionEngineering(project.id, screenplay);
            updateProject(project.id, updated);
            toast.success("工程剧本已校验并采用", { body: "原始剧本保持不变。下一步请提取并确认资产。" });
            document.dispatchEvent(new CustomEvent("1okstudio:navigateStep", { detail: "cast" }));
        } catch (error) {
            toast.error("工程剧本未采用", { body: detailOf(error) });
        } finally {
            setBusy("");
        }
    };

    return (
        <div className="flex h-full min-h-0 flex-col overflow-hidden">
            <StepPageHeader stepNumber={2} englishName="ENGINEERING SCRIPT" title="工程剧本" subtitle="所有原始内容都按已确认风格转为工程分镜；工程剧本本身就是后续分镜，不会再用 AI 重拆。" />
            <div className="grid min-h-0 flex-1 grid-cols-2 gap-4 overflow-hidden bg-surface p-6">
                <section className="flex min-h-0 flex-col rounded-xl border border-glass-border bg-glass p-4">
            <div className="mb-3 flex items-center justify-between gap-3">
                        <div><h2 className="text-sm font-semibold text-foreground">原始剧本 / 用户输入</h2><p className="mt-1 text-xs text-text-muted">独立保存；生成与采用不会覆盖本栏。</p></div>
                        <WorkflowActionButton size="sm" variant="secondary" loading={busy === "source"} onClick={() => void saveSource()}>保存原文</WorkflowActionButton>
                    </div>
                    <textarea value={source} onChange={(event) => setSource(event.target.value)} placeholder="粘贴完整剧本、小说片段或其他剧情内容…" className="min-h-0 flex-1 resize-none rounded-lg border border-glass-border bg-input-bg p-4 text-sm leading-7 text-foreground outline-none focus:border-primary/60" />
                </section>
                <section className="flex min-h-0 flex-col rounded-xl border border-glass-border bg-glass p-4">
                    <div className="mb-3 flex items-center justify-between gap-3">
                        <div><h2 className="text-sm font-semibold text-foreground">工程剧本</h2><p className="mt-1 text-xs text-text-muted">生成后自动按镜头时间码解析；可直接作为后续分段依据。</p></div>
                        <WorkflowActionButton size="sm" variant="secondary" loading={busy === "generate" || ["queued", "processing"].includes(project.production_engineering_task?.status ?? "")} disabled={!source.trim() || busy !== ""} onClick={() => void generate()}>生成并继续</WorkflowActionButton>
                    </div>
                    <textarea value={screenplay} onChange={(event) => setScreenplay(event.target.value)} disabled={busy === "generate"} placeholder="点击“按确认风格生成”，或粘贴已有工程台本后校验采用…" className="min-h-0 flex-1 resize-none rounded-lg border border-glass-border bg-input-bg p-4 font-mono text-xs leading-6 text-foreground outline-none focus:border-primary/60 disabled:opacity-60" />
                    <div className="mt-3 flex items-center justify-between gap-3">
                        <span className={`text-xs ${isAdopted ? "text-emerald-300" : "text-text-muted"}`}>{isAdopted ? `已解析 · ${currentPlan?.shots?.length || 0} 镜 · ${currentPlan?.duration || 0} 秒` : currentPlan ? "原文或风格已变化，请重新解析" : "当前草稿尚未解析，解析后才能提取资产"}</span>
                        {(!isAdopted || hasManualEdits) && <WorkflowActionButton size="sm" variant="primary" loading={busy === "adopt"} disabled={busy !== ""} onClick={() => void adopt()}>{hasManualEdits ? "应用修改并继续" : "采用并继续"}</WorkflowActionButton>}
                    </div>
                </section>
            </div>
        </div>
    );
}
