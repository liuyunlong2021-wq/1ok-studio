'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { h3ParameterError, h3PromptEnhancer, h3RequestError, type H3Input, type H3Job } from '@/lib/h3PromptEnhancer';

const storageKey = (contextId: string) => `1okstudio:h3-enhancement:${contextId}`;
function remember(contextId: string, id: string | null) {
  try { if (id) localStorage.setItem(storageKey(contextId), id); else localStorage.removeItem(storageKey(contextId)); } catch { /* The server still retains the task and source snapshot. */ }
}
function wait(signal: AbortSignal, seconds = 3) {
  return new Promise<void>((resolve) => {
    const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve(); };
    const timer = setTimeout(finish, Math.max(3, Math.min(seconds, 60)) * 1000);
    signal.addEventListener('abort', finish, { once: true });
    if (signal.aborted) finish();
  });
}

/** Both entry points resume the saved task; polling never creates a second task. */
export function useH3PromptEnhancement(contextId: string) {
  const [job, setJob] = useState<H3Job | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const pending = useRef<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  const epoch = useRef(0);
  const running = useRef(false);

  const poll = useCallback(async (id: string, signal: AbortSignal, generation: number) => {
    const deadline = Date.now() + 10 * 60 * 1000;
    while (!signal.aborted && generation === epoch.current) {
      const state = await h3PromptEnhancer.get(id, signal);
      if (signal.aborted || generation !== epoch.current) return;
      setJob(state);
      setError(state.error);
      if (['completed', 'failed', 'unknown'].includes(state.status)) return;
      if (Date.now() > deadline) { setError('等待已暂停，后台任务仍可能在处理。点击继续查询即可，不会重新提交。'); return; }
      await wait(signal, state.retry_after);
    }
  }, []);

  const execute = useCallback(async (id: string, input?: H3Input) => {
    if (running.current) return;
    running.current = true;
    const generation = epoch.current;
    const active = new AbortController();
    controller.current = active;
    setBusy(true); setError('');
    try {
      if (input) {
        const created = await h3PromptEnhancer.create(id, input, active.signal);
        if (active.signal.aborted || generation !== epoch.current) return;
        setJob(created);
      }
      await poll(id, active.signal, generation);
    } catch (reason) {
      if (!active.signal.aborted && generation === epoch.current) {
        const status = (reason as { response?: { status?: number } })?.response?.status;
        if (input && status && [400, 401, 402, 409, 422].includes(status)) {
          pending.current = null; remember(contextId, null); setJob(null);
        }
        setError(h3RequestError(reason));
      }
    } finally {
      if (generation === epoch.current) { running.current = false; setBusy(false); }
    }
  }, [poll, contextId]);

  useEffect(() => {
    ++epoch.current;
    running.current = false;
    setJob(null); setBusy(false); setError('');
    let id: string | null = null;
    try { id = localStorage.getItem(storageKey(contextId)); } catch { /* No saved task. */ }
    pending.current = id;
    if (id) void execute(id);
    return () => { ++epoch.current; controller.current?.abort(); running.current = false; };
  }, [contextId, execute]);

  const run = useCallback((input: H3Input) => {
    if (running.current || pending.current) return;
    const invalid = h3ParameterError(input.duration, input.ratio);
    if (invalid) { setError(invalid); return; }
    if (!input.text.trim() && !input.instruction?.trim()) { setError('请输入提示词或本次要求'); return; }
    const id = crypto.randomUUID();
    pending.current = id;
    remember(contextId, id); // Persist before POST, including when its response is lost.
    void execute(id, input);
  }, [contextId, execute]);

  const clear = useCallback(() => {
    controller.current?.abort(); ++epoch.current; running.current = false;
    pending.current = null; remember(contextId, null);
    setJob(null); setBusy(false); setError('');
  }, [contextId]);
  const resume = useCallback(() => { if (pending.current) void execute(pending.current); }, [execute]);
  return { job, busy, error, pendingId: pending.current, run, resume, clear };
}
