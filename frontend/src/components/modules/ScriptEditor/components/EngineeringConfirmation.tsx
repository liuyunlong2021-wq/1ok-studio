'use client';

import { useEffect, useState } from 'react';
import type { Editor } from '@tiptap/react';
import { api } from '@/lib/api';
import { scriptEditorApi } from '@/lib/scriptEditorApi';
import { useProjectStore } from '@/store/projectStore';
import { useEditorStore } from '@/store/editorStore';
import { extractErrorDetail } from '@/lib/utils';
import { scriptTextOf } from '../documentText';

export default function EngineeringConfirmation({ editor, projectId, previewing }: { editor: Editor | null; projectId: string | null; previewing: boolean }) {
    const project = useProjectStore(state => state.currentProject);
    const dirty = useEditorStore(state => state.isDirty);
    const [status, setStatus] = useState<Awaited<ReturnType<typeof api.getEngineeringStatus>> | null>(null);
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);
    useEffect(() => {
        let cancelled = false;
        setStatus(null); setError('');
        if (projectId) api.getEngineeringStatus(projectId).then(value => { if (!cancelled) setStatus(value); }).catch(e => { if (!cancelled) setError(extractErrorDetail(e, '台本状态读取失败')); });
        return () => { cancelled = true; };
    }, [projectId, project?.originalText, project?.engineering_script?.revision]);

    const confirm = async () => {
        if (!editor || !projectId || busy) return;
        const text = scriptTextOf(editor);
        const content = editor.getJSON();
        setBusy(true); setError('');
        try {
            await scriptEditorApi.saveDocument(projectId, content, true);
            if (editor.isDestroyed || scriptTextOf(editor) !== text) throw new Error('正文在保存时发生变化，请再确认一次');
            const updated = await api.confirmEngineeringScript(projectId, text);
            useProjectStore.getState().updateProject(projectId, updated);
            if (!editor.isDestroyed && scriptTextOf(editor) === text) {
                useEditorStore.getState().setDirty(false);
                useEditorStore.getState().setLastSavedAt(new Date());
            }
            setStatus(await api.getEngineeringStatus(projectId));
        } catch (e) { setError(extractErrorDetail(e, '工程台本确认失败')); }
        finally { setBusy(false); }
    };

    if (!projectId) return null;
    const current = status?.current && !dirty;
    return <div className="shrink-0 border-b border-border-subtle bg-primary/5 px-4 py-2 text-xs">
        <div className="flex flex-wrap items-center justify-between gap-2">
            <div><p className="text-text-secondary">{current ? `工程台本已确认 · ${status.count} 镜 · ${status.duration} 秒` : status?.confirmed ? '正文已修改，节奏需重新确认' : '先用「工程台本 · 节奏与镜头设计」Skill 调整节奏，再确认台本'}</p><p className="mt-1 text-text-muted">分镜沿用确认后的镜头编号、时间码、画面与摄影规格。</p></div>
            <button type="button" onClick={confirm} disabled={!editor || busy || previewing} className="rounded bg-primary px-3 py-1.5 font-medium text-on-accent disabled:opacity-40">{busy ? '校验并保存…' : current ? '重新确认工程台本' : '确认工程台本'}</button>
        </div>
        {error && <p role="alert" className="mt-2 text-red-400 whitespace-pre-wrap">{error}</p>}
    </div>;
}
