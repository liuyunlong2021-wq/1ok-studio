'use client';

import { useEffect, useMemo, useState } from 'react';
import { Loader2, Send, Upload } from 'lucide-react';
import type { Editor } from '@tiptap/react';
import { scriptEditorApi, type ScriptSkill } from '@/lib/scriptEditorApi';
import { scriptTextOf } from '../documentText';

export interface AiPreview {
  text: string;
  range: { from: number; to: number } | null;
}

/** 锁定的作用范围。`null` = 全文。 */
export interface AiScope {
  from: number;
  to: number;
  /** 框选那一刻的正文快照 —— 面板里给人看「改的就是这段」，应用前也用它校验。 */
  text: string;
}

export default function AiPanel({ editor, projectId, onPreview, scope, onScopeChange }: {
  editor: Editor | null;
  projectId?: string;
  onPreview: (preview: AiPreview) => void;
  /** 当前作用范围，由父级持有（编辑器还要拿它画高亮）。 */
  scope: AiScope | null;
  onScopeChange: (scope: AiScope | null) => void;
}) {
  const [skills, setSkills] = useState<ScriptSkill[]>([]);
  const [skillId, setSkillId] = useState('');
  const [instruction, setInstruction] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    scriptEditorApi.listScriptSkills().then((items) => {
      setSkills(items);
      setSkillId((current) => current || items.find((item) => item.id === 'builtin-short')?.id || items[0]?.id || '');
    }).catch(() => setError('Skill 加载失败'));
  }, []);

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
  // 空白不计入字数，否则「已框选 128 字」和看到的字对不上
  const scopeLength = scope ? scope.text.replace(/\s/g, '').length : 0;

  const send = async () => {
    if (!editor || !projectId || !selectedSkill || busy) return;
    const text = scope ? scope.text : scriptTextOf(editor);
    if (!text.trim()) return;
    setBusy(true);
    setError('');
    try {
      const result = await scriptEditorApi.standardizeScript(projectId, text, selectedSkill.content, selectedSkill.id, instruction);
      onPreview({
        text: result.standardized_text,
        range: scope ? { from: scope.from, to: scope.to } : null,
      });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '生成失败，请重试');
    } finally {
      setBusy(false);
    }
  };

  const upload = (file?: File) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const created = await scriptEditorApi.createScriptSkill(file.name.replace(/\.(md|markdown|txt)$/i, ''), String(reader.result || ''));
        setSkills((items) => [...items, created]);
        setSkillId(created.id);
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : 'Skill 上传失败');
      }
    };
    reader.readAsText(file);
  };

  return (
    <div className="flex h-full flex-col p-4">
      <div><h2 className="text-sm font-semibold text-foreground">AI 修改剧本</h2><p className="mt-1 text-xs text-text-muted">加载 Skill，输入要求，结果将在左侧预览。</p></div>
      <div className="mt-5 space-y-2">
        <div className="flex items-center justify-between">
          <label htmlFor="script-ai-skill" className="text-xs font-medium text-text-secondary">Skill</label>
          <label className="cursor-pointer text-xs text-primary"><Upload size={13} className="mr-1 inline" />上传<input type="file" accept=".md,.markdown,.txt" className="hidden" onChange={(event) => upload(event.target.files?.[0])} /></label>
        </div>
        <select id="script-ai-skill" value={skillId} onChange={(event) => setSkillId(event.target.value)} className="w-full rounded-lg border border-border-subtle bg-surface px-3 py-2 text-xs text-foreground">
          {!skills.length && <option value="">加载中…</option>}
          {skills.map((item) => <option key={item.id} value={item.id}>{item.name}{item.is_builtin ? ' · 内置' : ''}</option>)}
        </select>
        {selectedSkill && <details className="rounded-lg border border-border-subtle bg-surface px-3 py-2 text-xs text-text-muted"><summary className="cursor-pointer">已加载：{selectedSkill.name}</summary><pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap font-mono text-[0.625rem]">{selectedSkill.content}</pre></details>}
      </div>
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
            <span className="text-text-muted">作用范围：全文（在左侧正文里框选，可只改选中的段落）</span>
          )}
        </div>
        {scope ? (
          <pre className="mt-1.5 max-h-24 shrink-0 overflow-auto whitespace-pre-wrap rounded-lg border border-primary/30 bg-primary/[0.06] px-2.5 py-2 font-sans text-[0.6875rem] leading-relaxed text-text-secondary custom-scrollbar">
            {scope.text}
          </pre>
        ) : null}
        {error && <p className="mt-2 shrink-0 text-xs text-red-400">{error}</p>}
      </div>
      <button type="button" onClick={send} disabled={busy || !editor || !projectId || !selectedSkill} className="mt-4 flex w-full shrink-0 items-center justify-center gap-2 rounded-xl bg-primary px-4 py-3 text-sm font-semibold text-on-accent disabled:opacity-40">
        {busy ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />}{busy ? '生成中…' : '发送'}
      </button>
    </div>
  );
}
