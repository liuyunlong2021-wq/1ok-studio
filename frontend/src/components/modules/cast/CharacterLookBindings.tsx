"use client";

import { useState } from "react";
import { api } from "@/lib/api";
import { useProjectStore } from "@/store/projectStore";
import { toast } from "@/store/toastStore";

export default function CharacterLookBindings({ character }: { character: any }) {
    const project = useProjectStore((state) => state.currentProject);
    const updateProject = useProjectStore((state) => state.updateProject);
    const [saving, setSaving] = useState(false);
    if (!project || !character.looks?.length) return null;
    const frames = (project.frames || []).filter((frame: any) => frame.character_ids?.includes(character.id));
    return <details className="rounded-lg border border-glass-border p-3 text-xs text-text-muted">
        <summary className="cursor-pointer">镜头造型绑定 · {frames.length} 镜</summary>
        <div className="mt-2 max-h-48 space-y-2 overflow-auto">{frames.map((frame: any) => <label key={frame.id} className="flex items-center justify-between gap-2"><span>镜头{frame.source_shot_number}</span><select aria-label={`镜头${frame.source_shot_number}造型`} disabled={saving} value={frame.character_look_ids?.[character.id] || (character.looks.length === 1 ? character.looks[0].id : "")} onChange={async (event) => {
            const lookId = event.target.value;
            if (!lookId) return;
            setSaving(true);
            try {
                await api.updateFrame(project.id, frame.id, { character_look_ids: { ...frame.character_look_ids, [character.id]: lookId }, source_revision: frame.source_revision });
                updateProject(project.id, await api.getProject(project.id));
                toast.success("镜头造型已保存", { body: "涉及的分段提示词需要重新采用并生成。" });
            } catch (error: any) { toast.error("造型绑定保存失败", { body: error?.response?.data?.detail || error?.message }); }
            finally { setSaving(false); }
        }} className="max-w-48 rounded border border-glass-border bg-input-bg p-1.5"><option value="" disabled>待指定造型</option>{character.looks.map((look: any) => <option key={look.id} value={look.id}>{look.name}</option>)}</select></label>)}</div>
    </details>;
}
