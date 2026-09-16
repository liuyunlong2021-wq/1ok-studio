'use client';

import { useEffect, useMemo, useState } from 'react';
import { Loader2, Send, Upload } from 'lucide-react';
import type { Editor } from '@tiptap/react';
import { scriptEditorApi, type ScriptSkill } from '@/lib/scriptEditorApi';

export interface AiPreview {
  text: string;
  range: { from: number; to: number } | null;
}

export default function AiPanel({ editor, projectId, onPreview }: {
  editor: Editor | null;
  projectId?: string;
  onPreview: (preview: AiPreview) => void;
}) {
  const [skills, setSkills] = useState<ScriptSkill[]>([]);
  const [skillId, setSkillId] = useState('');
  const [instruction, setInstruction] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [, refreshSelection] = useState(0);

  useEffect(() => {
    scriptEditorApi.listScriptSkills().then((items) => {
      setSkills(items);
      setSkillId((current) => current || items.find((item) => item.id === 'builtin-short')?.id || items[0]?.id || '');
    }).catch(() => setError('Skill 加载失败'));
  }, []);

  useEffect(() => {
    if (!editor) return;
    const update = () => refreshSelection((value) => value + 1);
    editor.on('selectionUpdate', update);
    return () => { editor.off('selectionUpdate', update); };
  }, [editor]);

  const selectedSkill = useMemo(() => skills.find((item) => item.id === skillId), [skills, skillId]);
  const selection = editor?.state.selection;
  const hasSelection = Boolean(selection && selection.from !== selection.to);

  const send = async () => {
    if (!editor || !projectId || !selectedSkill || busy) return;
    const range = hasSelection && selection ? { from: selection.from, to: selection.to } : null;
    const text = range ? editor.state.doc.textBetween(range.from, range.to, '\n') : editor.getText();
    if (!text.trim()) return;
    setBusy(true);
    setError('');
    try {
      const result = await scriptEditorApi.standardizeScript(projectId, text, selectedSkill.content, selectedSkill.id, instruction);
      onPreview({ text: result.standardized_text, range });
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
      <div className="mt-5 flex-1">
        <label htmlFor="script-ai-instruction" className="text-xs font-medium text-text-secondary">本次要求</label>
        <textarea id="script-ai-instruction" value={instruction} onChange={(event) => setInstruction(event.target.value)} placeholder="输入这次希望 AI 完成的修改要求" className="mt-2 h-36 w-full resize-y rounded-lg border border-border-subtle bg-surface p-3 text-xs text-foreground" />
        <p className="mt-2 text-xs text-text-muted">作用范围：{hasSelection ? '当前选区' : '全文'}</p>
        {error && <p className="mt-2 text-xs text-red-400">{error}</p>}
      </div>
      <button type="button" onClick={send} disabled={busy || !editor || !projectId || !selectedSkill} className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl bg-primary px-4 py-3 text-sm font-semibold text-on-accent disabled:opacity-40">
        {busy ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />}{busy ? '生成中…' : '发送'}
      </button>
    </div>
  );
}
