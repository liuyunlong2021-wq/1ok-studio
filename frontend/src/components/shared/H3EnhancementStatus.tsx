'use client';

import type { H3Job } from '@/lib/h3PromptEnhancer';

export default function H3EnhancementStatus({ job, busy, error, pendingId, onResume, onClear }: {
  job: H3Job | null; busy: boolean; error: string; pendingId: string | null;
  onResume: () => void; onClear: () => void;
}) {
  if (!pendingId && !error) return null;
  return <div className="mt-2 space-y-2 rounded-lg border border-border-subtle bg-surface p-3 text-xs">
    {busy && <p role="status" className="text-primary">{job?.status === 'queued' || job?.status === 'preparing' || job?.status === 'submitting' || !job ? job?.status === 'preparing' ? '准备参考图片…' : '提交增强任务…' : '增强中…'}</p>}
    {error && <p role="alert" className="text-red-400">{error}</p>}
    {job?.status === 'unknown' && <p className="text-text-muted">提交可能已受理，请先核对网关任务或账户记录，再结束本次增强。结束不会取消上游任务。</p>}
    {pendingId && <details className="text-text-muted"><summary className="cursor-pointer">任务记录</summary><p className="mt-1 break-all">本地任务：{pendingId}</p>{job?.response_id && <p className="break-all">响应 ID：{job.response_id}</p>}</details>}
    {!busy && pendingId && job?.status !== 'completed' && <div className="flex gap-3">
      {!['unknown', 'failed'].includes(job?.status ?? '') && <button type="button" onClick={onResume} className="text-primary">继续查询</button>}
      <button type="button" onClick={onClear} className="text-text-secondary">结束本次增强</button>
    </div>}
  </div>;
}
