'use client';

import { useEffect, useState } from 'react';
import { Clipboard, Loader2, RefreshCw, Upload, X } from 'lucide-react';
import { DEFAULT_MODEL_SETTINGS, GLOBAL_TEXT_MODELS } from '@/lib/modelCatalog';
import { scriptEditorApi, type ScriptSkill } from '@/lib/scriptEditorApi';
import type { Editor } from '@tiptap/react';

function toEditorDocument(value: string) {
  const text = value.replace(/```(?:text|markdown)?/gi, '').replace(/```/g, '').replace(/\r\n?/g, '\n').trim();
  return { type: 'doc', content: text.split('\n').map((line) => ({ type: 'action', content: line ? [{ type: 'text', text: line }] : [] })) };
}

export default function StandardizeDialog({ projectId, editor, onClose }: { projectId: string; editor: Editor; onClose: () => void }) {
  const selection = editor.state.selection;
  const hasSelection = selection.from !== selection.to;
  const initialText = hasSelection ? editor.state.doc.textBetween(selection.from, selection.to, '\n') : editor.getText();
  const [text, setText] = useState(initialText);
  const [instruction, setInstruction] = useState('');
  const [skill, setSkill] = useState('');
  const [skillId, setSkillId] = useState('');
  const [skills, setSkills] = useState<ScriptSkill[]>([]);
  const [manageOpen, setManageOpen] = useState(false);
  const [model, setModel] = useState(DEFAULT_MODEL_SETTINGS.text_model);
  const [preview, setPreview] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { scriptEditorApi.listScriptSkills().then(setSkills).catch(() => undefined); }, []);
  const run = async () => { if (!text.trim()) return; setBusy(true); try { setPreview((await scriptEditorApi.standardizeScript(projectId, text, skill, model, skillId, instruction)).standardized_text); } catch (e) { setPreview(`修改失败：${e instanceof Error ? e.message : '请检查 API 配置'}`); } finally { setBusy(false); } };
  const selectSkill = (id: string) => { const selected = skills.find((item) => item.id === id); setSkillId(id); setSkill(selected?.content || ''); };
  const upload = (file?: File) => { if (!file) return; const reader = new FileReader(); reader.onload = async () => { const created = await scriptEditorApi.createScriptSkill(file.name.replace(/\.(md|markdown|txt)$/i, ''), String(reader.result || '')); setSkills((items) => [...items, created]); setSkillId(created.id); setSkill(created.content); }; reader.readAsText(file); };
  const renameSkill = async (item: ScriptSkill) => { const name = window.prompt('Skill 名称', item.name); if (!name?.trim()) return; const updated = await scriptEditorApi.updateScriptSkill(item.id, name, item.content); setSkills((items) => items.map((value) => value.id === item.id ? updated : value)); };
  const deleteSkill = async (item: ScriptSkill) => { if (!window.confirm(`删除「${item.name}」？`)) return; await scriptEditorApi.deleteScriptSkill(item.id); setSkills((items) => items.filter((value) => value.id !== item.id)); if (skillId === item.id) { setSkillId(''); setSkill(''); } };
  const apply = () => { const doc = toEditorDocument(preview); if (hasSelection) editor.commands.insertContentAt({ from: selection.from, to: selection.to }, doc.content ?? []); else editor.commands.setContent(doc); editor.commands.focus(); onClose(); };
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}><div className="w-full max-w-5xl rounded-2xl border border-border-subtle bg-elevated p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
    <div className="mb-4 flex items-center justify-between"><div><h2 className="text-base font-semibold text-foreground">AI 修改剧本</h2><p className="text-xs text-text-muted">选择 Skill，对全文或选中内容进行修改</p></div><button type="button" onClick={onClose}><X size={18} /></button></div>
    <div className="mb-3 flex flex-wrap items-center gap-3"><label className="text-xs text-text-secondary">文本模型</label><select value={model} onChange={(e) => setModel(e.target.value)} className="rounded border border-border-subtle bg-surface px-2 py-1 text-xs text-foreground">{GLOBAL_TEXT_MODELS.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</select><label className="text-xs text-text-secondary">Skill</label><select value={skillId} onChange={(e) => selectSkill(e.target.value)} className="rounded border border-border-subtle bg-surface px-2 py-1 text-xs text-foreground"><option value="">自定义 / 粘贴</option>{skills.map((item) => <option key={item.id} value={item.id}>{item.name}{item.is_builtin ? ' · 内置' : ''}</option>)}</select><button type="button" onClick={() => setManageOpen((value) => !value)} className="text-xs text-primary">管理</button><label className="cursor-pointer text-xs text-primary"><Upload size={13} className="mr-1 inline" />上传 Skill<input type="file" accept=".md,.markdown,.txt" className="hidden" onChange={(e) => upload(e.target.files?.[0])} /></label></div>
    {manageOpen && <div className="mb-3 max-h-32 overflow-auto rounded-lg border border-border-subtle bg-surface p-2 text-xs">{skills.map((item) => <div key={item.id} className="flex items-center justify-between border-b border-border-subtle py-1 last:border-0"><span>{item.name}{item.is_builtin && <em className="ml-1 text-text-muted">内置</em>}</span><span className="flex gap-2"><button type="button" onClick={() => renameSkill(item)} className="text-primary">重命名</button><button type="button" onClick={() => deleteSkill(item)} className="text-red-400">删除</button></span></div>)}</div>}
    <textarea value={skill} onChange={(e) => setSkill(e.target.value)} placeholder="粘贴 Skill 内容（可选）" className="mb-3 h-20 w-full resize-y rounded-lg border border-border-subtle bg-surface p-3 text-xs text-foreground" />
    <div className="mb-3"><p className="mb-1 text-xs text-text-muted">本次修改要求（可选）</p><textarea value={instruction} onChange={(e) => setInstruction(e.target.value)} placeholder="例如：保留剧情，只优化对白节奏和动作描写" className="h-16 w-full resize-y rounded-lg border border-border-subtle bg-surface p-3 text-xs text-foreground" /></div>
    <div className="grid grid-cols-2 gap-3"><div><p className="mb-1 text-xs text-text-muted">待修改内容 · {hasSelection ? '选中内容' : '全文'}</p><textarea value={text} onChange={(e) => setText(e.target.value)} className="h-64 w-full resize-none rounded-lg border border-border-subtle bg-surface p-3 text-xs text-foreground" /></div><div><p className="mb-1 text-xs text-text-muted">AI 修改结果</p><textarea value={preview} onChange={(e) => setPreview(e.target.value)} className="h-64 w-full resize-none rounded-lg border border-primary/30 bg-surface p-3 text-xs text-foreground" placeholder="点击“生成结果”" /></div></div>
    <div className="mt-4 flex justify-end gap-2"><button type="button" onClick={onClose} className="rounded-lg border border-border-subtle px-3 py-2 text-xs">取消</button><button type="button" disabled={!preview} onClick={() => navigator.clipboard?.writeText(preview)} className="rounded-lg border border-border-subtle px-3 py-2 text-xs disabled:opacity-40"><Clipboard size={13} className="mr-1 inline" />复制结果</button><button type="button" onClick={run} disabled={busy || !text.trim()} className="rounded-lg bg-primary px-3 py-2 text-xs text-on-accent">{busy ? <Loader2 size={13} className="mr-1 inline animate-spin" /> : <RefreshCw size={13} className="mr-1 inline" />}生成结果</button><button type="button" disabled={!preview || busy || preview.startsWith('修改失败：')} onClick={apply} className="rounded-lg bg-emerald-600 px-3 py-2 text-xs text-white disabled:opacity-40">应用到编辑器</button></div>
  </div></div>;
}
