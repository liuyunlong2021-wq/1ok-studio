'use client';

import { useState } from 'react';
import { api, type EngineeringSyncPreview as SyncPreview } from '@/lib/api';
import { extractErrorDetail } from '@/lib/utils';
import { useProjectStore } from '@/store/projectStore';

export default function EngineeringSyncPreview({ projectId, preview, onClose, onApplied }: { projectId: string; preview: SyncPreview; onClose: () => void; onApplied: () => void }) {
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const changed = preview.changes.filter(item => item.kind !== 'unchanged');
    const labels = { added: '新增', updated: '修改', removed: '移入归档', unchanged: '保持' };
    const apply = async () => {
        setBusy(true); setError('');
        try {
            const updated = await api.applyEngineeringSync(projectId, preview.token);
            useProjectStore.getState().updateProject(projectId, updated);
            onApplied();
        } catch (e) { setError(extractErrorDetail(e, '同步失败，请关闭并重新预览')); }
        finally { setBusy(false); }
    };
    return <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-6" role="dialog" aria-modal="true" aria-label="工程台本同步预览">
        <div className="flex max-h-[85vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-border-subtle bg-surface shadow-xl">
            <div className="border-b border-border-subtle p-5"><h2 className="font-bold text-foreground">工程台本同步预览</h2><p className="mt-1 text-xs text-text-muted">确认后为 {preview.count} 镜，共 {preview.duration} 秒。已有图片和视频保留；修改镜头标记待复核，旧分镜存入归档。</p></div>
            <div className="overflow-y-auto p-5 space-y-3">
                <p className="text-sm text-text-secondary">新增 {preview.changes.filter(v => v.kind === 'added').length} · 修改 {preview.changes.filter(v => v.kind === 'updated').length} · 移入归档 {preview.changes.filter(v => v.kind === 'removed').length} · 保持 {preview.changes.filter(v => v.kind === 'unchanged').length}</p>
                {preview.warnings.length > 0 && <details open className="text-xs text-amber-500"><summary>资产绑定需检查（{preview.warnings.length}）</summary><ul className="mt-2 list-disc pl-4">{preview.warnings.map((v, i) => <li key={i}>{v}</li>)}</ul></details>}
                {changed.map(item => <details key={item.frame_id} className="rounded-lg border border-border-subtle p-3 text-xs"><summary className="cursor-pointer text-text-secondary">{labels[item.kind]} · {item.number ? `镜头${item.number}` : '旧分镜'} · {item.before_duration ?? '—'} → {item.duration ?? '—'} 秒{item.media_kept ? ' · 保留已有素材' : ''}</summary><div className="mt-3 grid gap-3 sm:grid-cols-2"><div><p className="mb-1 text-text-muted">同步前</p><pre className="whitespace-pre-wrap font-sans leading-relaxed text-text-secondary">{item.before || '无'}</pre></div><div><p className="mb-1 text-text-muted">确认台本</p><pre className="whitespace-pre-wrap font-sans leading-relaxed text-text-secondary">{item.after || '此镜移入归档'}</pre></div></div></details>)}
                {!changed.length && <p className="text-xs text-text-muted">镜头内容与确认台本一致。</p>}
                {error && <p role="alert" className="text-xs text-red-400">{error}</p>}
            </div>
            <div className="flex justify-end gap-3 border-t border-border-subtle p-4"><button type="button" disabled={busy} onClick={onClose} className="text-sm text-text-secondary">取消</button><button type="button" disabled={busy} onClick={apply} className="rounded-lg bg-primary px-4 py-2 text-sm text-on-accent disabled:opacity-40">{busy ? '同步中…' : '确认同步'}</button></div>
        </div>
    </div>;
}
