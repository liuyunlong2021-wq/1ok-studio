'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, Loader2, Send, Settings2, Upload } from 'lucide-react';
import type { Editor } from '@tiptap/react';
import { scriptEditorApi, type ScriptSkill } from '@/lib/scriptEditorApi';
import { promptEditorApi, type PromptContext } from '@/lib/promptEditorApi';
import { scriptTextOf } from '../documentText';
import { selectableSkills, type SelectableSkill } from '@/lib/skillSelection';
import ScriptSkillManager from '../dialogs/ScriptSkillManager';
import { H3_SKILL_ID, H3_RATIOS, h3ParameterError, h3Images, h3ImageModeError, type H3ImageMode } from '@/lib/h3PromptEnhancer';
import { useH3PromptEnhancement } from '@/hooks/useH3PromptEnhancement';
import H3EnhancementStatus from '@/components/shared/H3EnhancementStatus';

function selectionKey(projectId: string) { return `script-ai-skill:${projectId}`; }

function rememberSkill(projectId: string | undefined, id: string) {
  if (!projectId) return;
  try { localStorage.setItem(selectionKey(projectId), id); } catch { /* Storage may be unavailable. */ }
}

export interface AiPreview {
  /** AI 产出的新正文。 */
  text: string;
  /** 这次要替换的位置；`null` = 全文。 */
  range: { from: number; to: number } | null;
  /**
   * 发送那一刻、这个 range 上的原文。
   *
   * 校验必须拿它比，不能拿 `AiScope.text`：scope 会跟着选区实时更新，用户在
   * 等 AI 出结果时随手重新框一下，`scope.text` 就变成了别的段的文字，于是每次
   * 接受都报「原文已改动，作用范围失效」—— 可正文一个字都没动。
   */
  sourceText: string;
  sourceDocument?: string;
  sourceContext?: string;
  onResolved?: () => void;
}

/** 锁定的作用范围。`null` = 全文。 */
export interface AiScope {
  from: number;
  to: number;
  /** 框选那一刻的正文快照 —— 面板里给人看「改的就是这段」，应用前也用它校验。 */
  text: string;
}

function readableRequestError(reason: unknown): string {
  if (reason && typeof reason === 'object' && 'response' in reason) {
    const response = (reason as { response?: { data?: { detail?: unknown; message?: unknown } } }).response;
    const detail = response?.data?.detail ?? response?.data?.message;
    if (typeof detail === 'string' && detail.trim()) return detail;
  }
  return reason instanceof Error ? reason.message : '生成失败，请重试';
}

export default function AiPanel({ editor, projectId, onPreview, scope, onScopeChange, purpose = 'script', promptContext }: {
  purpose?: 'script' | 'prompt';
  promptContext?: PromptContext;
  editor: Editor | null;
  projectId?: string;
  onPreview: (preview: AiPreview) => void;
  /** 当前作用范围，由父级持有（编辑器还要拿它画高亮）。 */
  scope: AiScope | null;
  onScopeChange: (scope: AiScope | null) => void;
}) {
  const memoryId = purpose === 'prompt' ? 'prompt-editor' : projectId;
  const skillKind = purpose === 'prompt' ? 'all' : 'script';
  const contextId = useRef(projectId);
  contextId.current = projectId;
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [skills, setSkills] = useState<SelectableSkill[]>([]);
  const [skillId, setSkillId] = useState('');
  const skillIdRef = useRef('');
  const [instruction, setInstruction] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [loadingSkills, setLoadingSkills] = useState(true);
  const [showManager, setShowManager] = useState(false);
  const [importFile, setImportFile] = useState<File>();
  const h3 = useH3PromptEnhancement(`${purpose}:${projectId ?? ''}`);
  const deliveredH3 = useRef('');
  const [h3Duration, setH3Duration] = useState(() => {
    try { return Number(localStorage.getItem('1okstudio:h3-duration') ?? 5); } catch { return 5; }
  });
  const [h3ImageMode, setH3ImageMode] = useState<H3ImageMode>('reference');
  const [h3Ratio, setH3Ratio] = useState(() => {
    try { return localStorage.getItem('1okstudio:h3-ratio') ?? '9:16'; } catch { return '9:16'; }
  });
  useEffect(() => {
    try { localStorage.setItem('1okstudio:h3-duration', String(h3Duration)); localStorage.setItem('1okstudio:h3-ratio', h3Ratio); } catch { /* Optional preference. */ }
  }, [h3Duration, h3Ratio]);
  useEffect(() => { deliveredH3.current = ''; }, [projectId]);
  useEffect(() => {
    if (purpose !== 'prompt' || h3.job?.status !== 'completed' || deliveredH3.current === h3.job.job_id) return;
    try {
      const source = JSON.parse(h3.job.source_context) as { documentId: string; preview: Omit<AiPreview, 'text' | 'onResolved'> };
      if (source.documentId !== projectId) return;
      deliveredH3.current = h3.job.job_id;
      onPreview({ ...source.preview, text: h3.job.text, onResolved: h3.clear });
    } catch { setError('增强结果的原文记录无法读取，请保留任务 ID。'); }
  }, [h3.job, h3.clear, onPreview, projectId, purpose]);

  useEffect(() => {
    let cancelled = false;
    let remembered: string | null = null;
    try { remembered = memoryId ? localStorage.getItem(selectionKey(memoryId)) : null; } catch { /* Use the default on first load. */ }
    setLoadingSkills(true);
    setSkills([]);
    skillIdRef.current = '';
    setSkillId('');
    setError('');
    scriptEditorApi.listScriptSkills(skillKind).then((items) => {
      if (cancelled) return;
      const options = selectableSkills(items);
      setSkills(options);
      const id = options.find((item) => remembered && item.aliases.includes(remembered))?.id ?? '';
      rememberSkill(memoryId, id);
      skillIdRef.current = id;
      setSkillId(id);
      if (remembered && !id) {
        rememberSkill(memoryId, '');
        setError('之前选择的 Skill 已删除或隐藏，请重新选择。');
      }
    }).catch(() => { if (!cancelled) setError('Skill 加载失败'); }).finally(() => { if (!cancelled) setLoadingSkills(false); });
    return () => { cancelled = true; };
  }, [projectId, memoryId, skillKind]);

  const applySkills = useCallback((items: ScriptSkill[], selectedId?: string) => {
    const options = selectableSkills(items);
    setSkills(options);
    const previousId = skillIdRef.current;
    const candidateId = selectedId ?? previousId;
    const id = options.find((item) => item.aliases.includes(candidateId))?.id ?? '';
    skillIdRef.current = id;
    setSkillId(id);
    rememberSkill(memoryId, id);
    if (previousId && !id) setError('当前 Skill 已删除或隐藏，请重新选择。');
    else setError('');
  }, [memoryId]);

  useEffect(() => {
    let cancelled = false;
    const refresh = () => { void scriptEditorApi.listScriptSkills(skillKind).then((items) => { if (!cancelled) applySkills(items); }).catch(() => { if (!cancelled) setError('Skill 刷新失败'); }); };
    window.addEventListener('script-skills-changed', refresh);
    return () => { cancelled = true; window.removeEventListener('script-skills-changed', refresh); };
  }, [applySkills, skillKind]);

  useEffect(() => { setShowManager(false); setImportFile(undefined); setInstruction(''); onScopeChange(null); }, [projectId, onScopeChange]);

  // 作用范围 = 用户最后一次**框选**的内容。
  // 光标（from === to）刻意不算：否则点一下面板、点一下正文，作用范围就会在
  // 「一段」和「全文」之间无声地来回跳 —— 这正是原来那行灰字毫无意义的原因。
  useEffect(() => {
    if (!editor) return;
    const sync = () => {
      const { selection } = editor.state;
      if (selection.from === selection.to) return;
      onScopeChange({
        from: selection.from,
        to: selection.to,
        text: editor.state.doc.textBetween(selection.from, selection.to, '\n'),
      });
    };
    sync();
    editor.on('selectionUpdate', sync);
    return () => { editor.off('selectionUpdate', sync); };
  }, [editor, onScopeChange]);

  const selectedSkill = useMemo(() => skills.find((item) => item.id === skillId), [skills, skillId]);
  const isH3 = purpose === 'prompt' && selectedSkill?.id === H3_SKILL_ID;
  const h3Invalid = isH3 ? h3ParameterError(h3Duration, h3Ratio) || h3ImageModeError(promptContext?.images.length ?? 0, h3ImageMode) : '';
  const sending = busy || h3.busy;
  // 空白不计入字数，否则「已框选 128 字」和看到的字对不上
  const scopeLength = scope ? scope.text.replace(/\s/g, '').length : 0;

  useEffect(() => {
    if (purpose !== 'prompt' || !editor) return;
    const invalidate = () => {
      if (scope && (scope.to > editor.state.doc.content.size || editor.state.doc.textBetween(scope.from, scope.to, '\n') !== scope.text)) onScopeChange(null);
    };
    editor.on('update', invalidate);
    return () => { editor.off('update', invalidate); };
  }, [editor, scope, onScopeChange, purpose]);

  const send = async () => {
    if (!editor || !projectId || (!selectedSkill && !instruction.trim()) || sending) return;
    if (scope && (scope.to > editor.state.doc.content.size || editor.state.doc.textBetween(scope.from, scope.to, '\n') !== scope.text)) {
      onScopeChange(null); setError('选区已变化，请重新框选或改为全文'); return;
    }
    if (selectedSkill?.validation_error) { setError(`Skill 需要修复：${selectedSkill.validation_error}`); return; }
    const text = scope ? scope.text : purpose === 'prompt' ? editor.getText({ blockSeparator: '\n' }) : scriptTextOf(editor);
    if (!text.trim() && (purpose === 'script' || !instruction.trim())) { setError('请填写本次要求或输入正文'); return; }
    if (purpose === 'prompt' && (text.length > 200000 || instruction.length > 20000 || (selectedSkill?.content.length ?? 0) > 200000 || text.length + instruction.length + (selectedSkill?.content.length ?? 0) > 250000)) {
      setError('本次输入过长，请缩小作用范围或精简要求／Skill；未截断内容'); return;
    }
    const requestId = projectId;
    const sourceContext = purpose === 'prompt' ? JSON.stringify(promptContext ?? { style: null, images: [] }) : undefined;
    const sourceDocument = purpose === 'prompt' ? JSON.stringify(editor.getJSON()) : undefined;
    if (isH3) {
      if (h3.pendingId) return;
      setError('');
      const style = promptContext?.style;
      const contextInstruction = [style ? `风格：${style.name}\n${style.positive_prompt || style.description}${style.negative_prompt ? `\n避免：${style.negative_prompt}` : ''}` : '', instruction].filter(Boolean).join('\n\n');
      if (contextInstruction.length > 20000) { setError('风格与本次要求合计超过 20000 字，请精简后重试；未截断内容'); return; }
      h3.run({ text, instruction: contextInstruction, images: h3Images(promptContext?.images ?? [], h3ImageMode), duration: h3Duration, ratio: h3Ratio, source_context: JSON.stringify({ documentId: projectId, preview: { range: scope ? { from: scope.from, to: scope.to } : null, sourceText: text, sourceDocument, sourceContext } }) });
      return;
    }
    setBusy(true);
    setError('');
    try {
      const result = purpose === 'prompt'
        ? { standardized_text: (await promptEditorApi.generate(projectId, { text, instruction, skill: selectedSkill?.content ?? '', skill_id: selectedSkill?.id ?? '', ...promptContext, style: promptContext?.style ?? null, images: promptContext?.images ?? [] })).text }
        : await scriptEditorApi.standardizeScript(projectId, text, selectedSkill?.content ?? '', selectedSkill?.id, instruction);
      if (!mounted.current || contextId.current !== requestId) return;
      onPreview({
        text: result.standardized_text,
        range: scope ? { from: scope.from, to: scope.to } : null,
        sourceText: text,
        sourceDocument,
        sourceContext,
      });
    } catch (reason) {
      if (mounted.current) setError(readableRequestError(reason));
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col p-4">
      {/* 内容区自己滚，动作按钮留在滚动区之外。
          提示词编辑器右栏在窄窗口只有 450px 高、剧本编辑器右栏是 overflow-hidden，
          内容一高（尤其选中 H3 后多出时长/画幅/图片用途）按钮就会被挤到折叠线以下或被裁掉。 */}
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto custom-scrollbar">
        <div><h2 className="text-sm font-semibold text-foreground">{purpose === 'prompt' ? 'AI 创作与修改' : 'AI 修改剧本'}</h2><p className="mt-1 text-xs text-text-muted">输入修改要求，Skill 可选，结果将在左侧预览。</p></div>
        <div className="mt-5 space-y-2">
          <div className="flex items-center justify-between">
            <label htmlFor="script-ai-skill" className="text-xs font-medium text-text-secondary">Skill</label>
            <div className="flex items-center gap-3">
              <label className={`text-xs text-primary ${loadingSkills ? 'opacity-40' : 'cursor-pointer'}`}><Upload size={13} className="mr-1 inline" />上传<input type="file" accept={purpose === 'prompt' ? ' .md,.markdown,.txt,.zip'.trim() : '.md,.markdown,.txt'} disabled={loadingSkills} className="hidden" onChange={(event) => { const file = event.target.files?.[0]; if (file) { setImportFile(file); setShowManager(true); } event.target.value = ''; }} /></label>
              <button type="button" disabled={loadingSkills} onClick={() => { setImportFile(undefined); setShowManager(true); }} className="text-xs text-primary disabled:opacity-40"><Settings2 size={13} className="mr-1 inline" />管理</button>
            </div>
          </div>
          <select id="script-ai-skill" value={skillId} disabled={loadingSkills || sending} onChange={(event) => { skillIdRef.current = event.target.value; setSkillId(event.target.value); rememberSkill(memoryId, event.target.value); setError(''); }} className="w-full rounded-lg border border-border-subtle bg-surface px-3 py-2 text-xs text-foreground">
            <option value="">{loadingSkills ? '加载中…' : purpose === 'prompt' ? '不使用 Skill · 按本次要求创作' : '不使用 Skill · 按本次要求修改'}</option>
            {skills.map((item) => <option key={item.id} value={item.id} disabled={!!item.validation_error}>{item.displayName}{item.validation_error ? ' · 需修复' : ''}</option>)}
          </select>
          {selectedSkill && <details className="rounded-lg border border-border-subtle bg-surface px-3 py-2 text-xs text-text-muted"><summary className="cursor-pointer">已加载：{selectedSkill.name}</summary><pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap font-mono text-[0.625rem]">{selectedSkill.content}</pre></details>}
        </div>
        {isH3 && <div className="mt-3 space-y-2">
          <div className="grid grid-cols-2 gap-3">
            <label className="text-xs text-text-secondary">目标时长（秒）<input aria-label="H3 增强时长" type="number" min={4} max={15} step={1} value={Number.isFinite(h3Duration) ? h3Duration : ''} disabled={h3.busy} onChange={(event) => setH3Duration(event.target.value === '' ? NaN : Number(event.target.value))} className="mt-1 block h-10 w-full box-border rounded-lg border border-border-subtle bg-surface px-3 py-0 text-xs text-foreground" /></label>
            <label className="text-xs text-text-secondary">画幅<span className="relative mt-1 block"><select aria-label="H3 增强画幅" value={h3Ratio} disabled={h3.busy} onChange={(event) => setH3Ratio(event.target.value)} className="block h-10 w-full box-border appearance-none rounded-lg border border-border-subtle bg-surface pl-3 pr-8 py-0 text-xs text-foreground">{H3_RATIOS.map((ratio) => <option key={ratio} value={ratio}>{ratio}</option>)}</select><ChevronDown aria-hidden="true" className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-secondary" /></span></label>
          </div>
          <label className="block text-xs text-text-secondary">图片用途<select aria-label="H3 图片用途" value={h3ImageMode} disabled={h3.busy} onChange={(event) => setH3ImageMode(event.target.value as H3ImageMode)} className="mt-1 w-full rounded-lg border border-border-subtle bg-surface px-3 py-2 text-foreground"><option value="reference">参考图（无图时使用纯文本）</option><option value="first_frame">首帧</option><option value="last_frame">尾帧</option><option value="first_last">首尾帧（按图片顺序）</option></select></label>
          <p className="text-xs text-text-muted">使用选定风格和参考图片增强提示词，图片通过韭菜盒子临时上传。{h3ImageMode !== 'reference' ? '首尾帧画幅由图片决定。' : '图片编号沿用当前顺序。'}</p>
          {h3Invalid && <p className="text-xs text-red-400">{h3Invalid}</p>}
        </div>}
        {/* 占满剩下的高度：输入框随窗口伸缩，「已框选的那段」保持固定高度露在下面。 */}
        <div className="mt-5 flex min-h-0 flex-1 flex-col">
          <label htmlFor="script-ai-instruction" className="shrink-0 text-xs font-medium text-text-secondary">本次要求</label>
          <textarea id="script-ai-instruction" value={instruction} onChange={(event) => setInstruction(event.target.value)} placeholder="输入这次希望 AI 完成的修改要求" className="mt-2 min-h-[8rem] w-full flex-1 resize-none rounded-lg border border-border-subtle bg-surface p-3 text-xs leading-relaxed text-foreground custom-scrollbar" />
          <div className="mt-2 flex shrink-0 items-center gap-2 text-xs">
            {scope ? (
              <>
                <span className="shrink-0 text-text-secondary">作用范围：已框选 {scopeLength} 字</span>
                <button
                  type="button"
                  onClick={() => onScopeChange(null)}
                  className="shrink-0 text-primary hover:underline"
                >
                  改为全文
                </button>
              </>
            ) : (
              <span className="text-text-muted">{purpose === 'prompt' && !editor?.getText().trim() ? '作用范围：从零创作' : '作用范围：全文（在左侧正文里框选，可只改选中的段落）'}</span>
            )}
          </div>
          {scope ? (
            <pre className="mt-1.5 max-h-24 shrink-0 overflow-auto whitespace-pre-wrap rounded-lg border border-primary/30 bg-primary/[0.06] px-2.5 py-2 font-sans text-[0.6875rem] leading-relaxed text-text-secondary custom-scrollbar">
              {scope.text}
            </pre>
          ) : null}
          {error && <p className="mt-2 shrink-0 text-xs text-red-400">{error}</p>}
        </div>
      </div>
      <H3EnhancementStatus {...h3} onResume={h3.resume} onClear={h3.clear} />
      <button type="button" onClick={send} disabled={sending || !!h3Invalid || (isH3 && !!h3.pendingId) || !!selectedSkill?.validation_error || !editor || !projectId || (!selectedSkill && !instruction.trim()) || (purpose === 'prompt' && !editor?.getText().trim() && !instruction.trim())} className="mt-4 flex w-full shrink-0 items-center justify-center gap-2 rounded-xl bg-primary px-4 py-3 text-sm font-semibold text-on-accent disabled:opacity-40">
        {sending ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />}{sending ? isH3 ? '增强中…' : '生成中…' : isH3 ? '增强提示词' : '发送'}
      </button>
      {showManager && <ScriptSkillManager kind={skillKind} activeId={skillId} initialFile={importFile} onChange={applySkills} onClose={() => { setShowManager(false); setImportFile(undefined); }} />}
    </div>
  );
}
