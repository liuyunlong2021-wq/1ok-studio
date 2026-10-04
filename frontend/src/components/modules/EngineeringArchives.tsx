'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { extractErrorDetail, getAssetUrlWithTimestamp } from '@/lib/utils';
import { useProjectStore } from '@/store/projectStore';

export default function EngineeringArchives({ projectId, onClose }: { projectId: string; onClose: () => void }) {
    const [archives, setArchives] = useState<Awaited<ReturnType<typeof api.getEngineeringArchives>> | null>(null);
    const [error, setError] = useState('');
    const tasks = useProjectStore(state => state.currentProject?.video_tasks || []);
    useEffect(() => {
        let cancelled = false;
        api.getEngineeringArchives(projectId).then(value => { if (!cancelled) setArchives(value); }).catch(e => { if (!cancelled) setError(extractErrorDetail(e, '归档读取失败')); });
        return () => { cancelled = true; };
    }, [projectId]);
    return <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-6" role="dialog" aria-modal="true" aria-label="旧分镜归档">
        <div className="flex max-h-[85vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-border-subtle bg-surface shadow-xl">
            <div className="flex items-center justify-between border-b border-border-subtle p-5"><div><h2 className="font-bold text-foreground">旧分镜归档</h2><p className="mt-1 text-xs text-text-muted">同步前的镜头和素材保留在这里，可展开查看。</p></div><button type="button" onClick={onClose} className="text-sm text-primary">关闭</button></div>
            <div className="space-y-4 overflow-y-auto p-5 text-sm text-text-secondary">
                {error && <p role="alert" className="text-red-400">{error}</p>}
                {!archives && !error && <p>读取归档…</p>}
                {archives?.length === 0 && <p>暂无归档。</p>}
                {archives?.slice().reverse().map((archive, i) => <details key={`${archive.created_at}-${i}`} className="rounded-lg border border-border-subtle p-3"><summary className="cursor-pointer">{new Date(archive.created_at * 1000).toLocaleString()} · {archive.frames.length} 镜</summary><div className="mt-3 space-y-3">{archive.frames.map((frame, index) => {
                    const image = frame.rendered_image_url || frame.image_url;
                    const video = frame.video_url || tasks.find((task: any) => task.id === frame.selected_video_id)?.video_url;
                    return <div key={frame.id} className="rounded border border-border-subtle p-3"><p className="mb-2 font-medium">镜头 {frame.source_shot_number ?? index + 1} · {frame.duration ?? '—'} 秒</p>{image && <img src={getAssetUrlWithTimestamp(image, frame.updated_at)} alt="归档分镜" className="mb-2 max-h-48 max-w-full rounded object-contain" />}{video && <video controls preload="none" src={getAssetUrlWithTimestamp(video, frame.updated_at)} className="mb-2 max-h-64 max-w-full rounded" />}<pre className="whitespace-pre-wrap font-sans text-xs leading-relaxed">{frame.source_text || frame.visual_description || frame.action_description}</pre>{!frame.source_text && frame.dialogue && <p className="mt-2 text-xs">{frame.speaker}：{frame.dialogue}</p>}</div>;
                })}</div></details>)}
            </div>
        </div>
    </div>;
}
