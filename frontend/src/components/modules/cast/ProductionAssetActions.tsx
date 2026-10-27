"use client";

import { useState } from "react";
import { api, crudApi } from "@/lib/api";
import { useProjectStore } from "@/store/projectStore";
import { toast } from "@/store/toastStore";

type AssetKind = "character" | "scene" | "prop";

const KIND_LABEL: Record<AssetKind, string> = { character: "角色", scene: "场景", prop: "道具" };

function errorText(error: unknown) {
    const detail = (error as { response?: { data?: { detail?: unknown } } })?.response?.data?.detail;
    return typeof detail === "string" ? detail : error instanceof Error ? error.message : "操作失败，请重试。";
}

/**
 * 新制作流程资产卡片底部的整理操作：删除，以及把“其实是服装／场景一部分”的道具
 * 并入角色造型或场景描述。只给本集自有资产使用；共享资产由系列页管理。
 */
export default function ProductionAssetActions({ kind, id, name }: { kind: AssetKind; id: string; name: string }) {
    const project = useProjectStore((state) => state.currentProject);
    const updateProject = useProjectStore((state) => state.updateProject);
    const [folding, setFolding] = useState(false);
    const [target, setTarget] = useState("");
    const [busy, setBusy] = useState(false);
    if (!project) return null;

    const usedBySegments = (project.production_segments || []).some((segment: any) => (segment.asset_refs || []).some((ref: any) => ref.id === id));
    const replanHint = usedBySegments ? "\n该资产已用于分段方案，操作后需要回第 4 步重新按镜头分段。" : "";

    const finish = async (action: () => Promise<unknown>, message: string) => {
        setBusy(true);
        try {
            await action();
            updateProject(project.id, await api.getProject(project.id));
            toast.success(message);
            setFolding(false);
        } catch (error) {
            toast.error("资产整理失败", { body: errorText(error) });
        } finally {
            setBusy(false);
        }
    };

    const remove = () => {
        if (!window.confirm(`删除${KIND_LABEL[kind]}“${name}”？已生成的图片和镜头绑定会一起移除，无法撤销。${replanHint}`)) return;
        const action = kind === "character" ? () => crudApi.deleteCharacter(project.id, id) : kind === "scene" ? () => crudApi.deleteScene(project.id, id) : () => crudApi.deleteProp(project.id, id);
        void finish(action, `已删除“${name}”`);
    };

    const fold = () => {
        const [targetType, targetId, lookId] = target.split(":");
        if (!targetId) return;
        void finish(
            () => api.foldProductionProp(project.id, id, { target_type: targetType as "character" | "scene", target_id: targetId, look_id: lookId || undefined }),
            `“${name}”已并入${targetType === "character" ? "角色造型" : "场景陈设"}`,
        );
    };

    const characterOptions = (project.characters || []).flatMap((character: any) => character.looks?.length
        ? character.looks.map((look: any) => ({ value: `character:${character.id}:${look.id}`, label: `${character.name} · ${look.name}` }))
        : [{ value: `character:${character.id}`, label: character.name }]);
    const sceneOptions = (project.scenes || []).map((scene: any) => ({ value: `scene:${scene.id}`, label: scene.name }));

    return <div className="space-y-2 px-0.5">
        <div className="flex items-center justify-end gap-3 text-[0.6875rem]">
            {kind === "prop" && <button type="button" disabled={busy} onClick={() => setFolding((value) => !value)} className="text-text-muted hover:text-primary disabled:opacity-50">并入角色/场景</button>}
            <button type="button" disabled={busy} onClick={remove} className="text-text-muted hover:text-red-400 disabled:opacity-50">删除</button>
        </div>
        {folding && <div className="space-y-2 rounded-md border border-glass-border bg-black/10 p-2">
            <p className="text-[0.6875rem] leading-4 text-text-muted">道具描述会追加到所选造型或场景里，然后删除这个道具。{replanHint}</p>
            <select aria-label="并入目标" value={target} onChange={(event) => setTarget(event.target.value)} className="w-full rounded border border-glass-border bg-input-bg p-1.5 text-xs">
                <option value="">选择要并入的位置</option>
                {characterOptions.length > 0 && <optgroup label="角色造型">{characterOptions.map((option: any) => <option key={option.value} value={option.value}>{option.label}</option>)}</optgroup>}
                {sceneOptions.length > 0 && <optgroup label="场景陈设">{sceneOptions.map((option: any) => <option key={option.value} value={option.value}>{option.label}</option>)}</optgroup>}
            </select>
            <div className="flex justify-end gap-2 text-xs">
                <button type="button" onClick={() => setFolding(false)} className="text-text-muted hover:text-foreground">取消</button>
                <button type="button" disabled={!target || busy} onClick={fold} className="text-primary disabled:opacity-50">确认并入</button>
            </div>
        </div>}
    </div>;
}
