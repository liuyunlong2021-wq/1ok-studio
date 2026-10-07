'use client';

import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { EditorContent } from '@tiptap/react';
import { Save, Undo2, Redo2, Plus, History, X, Copy } from 'lucide-react';
import { promptEditorApi, type PromptDocument, type PromptVersion, type PromptContext } from '@/lib/promptEditorApi';
import { useEditorSetup } from '../ScriptEditor/hooks/useEditorSetup';
import AiPanel, { type AiPreview, type AiScope } from '../ScriptEditor/panels/AiPanel';
import AiResultPreview, { applyAiPreview, previewSourceChanged, textToEditorDocument } from '../ScriptEditor/components/AiResultPreview';
import { applyAiScope } from '../ScriptEditor/extensions';
import { usePlaygroundStore, type PlaygroundMode } from '../playground/usePlaygroundStore';
import { getModelsForMode } from '../playground/playgroundModels';
import PromptContextInput from './PromptContextInput';
import { getMediaInputConfig } from '../playground/mediaModes';
import { getModelMaxReferenceImages } from '../playground/playgroundModels';
import { getPromptMaxLength } from '../playground/promptLimits';
import { toast } from '@/store/toastStore';

const BUTTON = 'inline-flex items-center gap-1.5 rounded-lg border border-border-subtle px-3 py-2 text-xs hover:bg-hover-bg disabled:opacity-40';
const LAST_DOCUMENT = '1okstudio:prompt-editor:last-document';
function errorText(error: unknown): string {
  const detail = (error as { response?: { data?: { detail?: unknown } } })?.response?.data?.detail;
  return typeof detail === 'string' ? detail : error instanceof Error ? error.message : '操作失败，请重试';
}
interface EditorHandle { save: (snapshot?: boolean) => Promise<boolean> }

const PromptDocumentEditor = forwardRef<EditorHandle, { document: PromptDocument; onSaved: (document: PromptDocument) => void; switching: boolean }>(function PromptDocumentEditor({ document, onSaved, switching }, ref) {
  const initialContent = useRef(textToEditorDocument(document.text, 'prompt')).current;
  const { editor } = useEditorSetup({ purpose: 'prompt', content: initialContent });
  const [context, setContext] = useState<PromptContext>({ style: document.style ?? null, images: document.images ?? [] });
  const [includeImages, setIncludeImages] = useState(true);
  const [handoffBusy, setHandoffBusy] = useState(false);
  const [mediaAction, setMediaAction] = useState<'replace' | 'append'>('replace');
  const [name, setName] = useState(document.name);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [lastSaved, setLastSaved] = useState(document.updated_at);
  const [editTick, setEditTick] = useState(0);
  const [scope, setScope] = useState<AiScope | null>(null);
  const [preview, setPreview] = useState<AiPreview | null>(null);
  const [versions, setVersions] = useState<PromptVersion[] | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [handoff, setHandoff] = useState<'image' | 'video' | 'audio' | null>(null);
  const alive = useRef(true);
  const saved = useRef(document);
  const draft = useRef({ name: document.name, text: document.text, style: document.style ?? null, images: document.images ?? [] });
  const contextKey = () => JSON.stringify({ style: draft.current.style, images: draft.current.images });
  const sameSaved = () => JSON.stringify({ ...draft.current, name: draft.current.name.trim() || '未命名提示词' }) === JSON.stringify({ name: saved.current.name, text: saved.current.text, style: saved.current.style ?? null, images: saved.current.images ?? [] });
  const serial = useRef<Promise<boolean>>(Promise.resolve(true));
  const actionLock = useRef(false);
  const onSavedRef = useRef(onSaved);
  onSavedRef.current = onSaved;

  const save = useCallback((snapshot = false): Promise<boolean> => {
    const run = async () => {
      try {
        if (alive.current) { setSaving(true); setSaveError(''); }
        let first = true;
        do {
          const current = { ...draft.current, name: draft.current.name.trim() || '未命名提示词' };
          if (!snapshot && sameSaved()) break;
          const response = await promptEditorApi.save(document.id, { ...current, revision: saved.current.revision, snapshot: first && snapshot });
          first = false;
          snapshot = false;
          saved.current = response;
          onSavedRef.current(response);
          if (alive.current) setLastSaved(response.updated_at);
        } while (!sameSaved());
        if (alive.current) setDirty(false);
        return true;
      } catch (error) {
        if (alive.current) setSaveError(errorText(error));
        toast.error('提示词文档保存失败', { body: errorText(error) });
        return false;
      } finally {
        if (alive.current) setSaving(false);
      }
    };
    const next = serial.current.then(run, run);
    serial.current = next;
    return next;
  }, [document.id]);
  useImperativeHandle(ref, () => ({ save }), [save]);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; void save(); };
  }, [save]);
  useEffect(() => {
    if (!editor) return;
    const update = () => {
      draft.current.text = editor.getText({ blockSeparator: '\n' });
      setDirty(true); setEditTick((tick) => tick + 1);
    };
    // Transactions also refresh undo/redo availability and selection-dependent actions.
    const transaction = () => setEditTick((tick) => tick + 1);
    editor.on('update', update);
    editor.on('transaction', transaction);
    return () => { editor.off('update', update); editor.off('transaction', transaction); };
  }, [editor]);
  useEffect(() => {
    if (!dirty || restoring) return;
    const timer = setTimeout(() => { void save(); }, 1000);
    return () => clearTimeout(timer);
  }, [dirty, editTick, save, restoring]);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (!sameSaved()) { event.preventDefault(); event.returnValue = ''; }
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, []);
  useEffect(() => { if (editor) editor.setEditable(!switching && !restoring); }, [editor, switching, restoring]);
  useEffect(() => { if (editor && !editor.isDestroyed) applyAiScope(editor.view, scope ? { from: scope.from, to: scope.to } : null); }, [editor, scope]);

  const accept = async () => {
    if (!editor || !preview || actionLock.current) return;
    actionLock.current = true;
    try {
      if ((previewSourceChanged(editor, preview) || preview.sourceContext !== contextKey())) {
        toast.error('原文已改动，不能覆盖新编辑', { body: '可复制预览结果，或放弃后重新生成。' }); return;
      }
      // Persist the source as a restorable version before changing the document.
      if (!await save(true)) return;
      if (!alive.current || editor.isDestroyed) return;
      if ((previewSourceChanged(editor, preview) || preview.sourceContext !== contextKey())) { toast.error('原文已变化，请重新生成'); return; }
      applyAiPreview(editor, preview, 'prompt');
      preview.onResolved?.();
      setPreview(null); setScope(null);
      await save(true);
    } finally { actionLock.current = false; }
  };
  const showHistory = async () => {
    if (!await save(true)) return;
    try { setVersions(await promptEditorApi.versions(document.id)); } catch (error) { toast.error(errorText(error)); }
  };
  const restore = async (version: PromptVersion) => {
    if (!editor || actionLock.current || switching) return;
    actionLock.current = true; setRestoring(true);
    try {
      if (!await save(true)) return;
      const response = await promptEditorApi.restore(document.id, version.id, saved.current.revision);
      if (!alive.current || editor.isDestroyed) return;
      saved.current = response;
      draft.current = { name: response.name, text: response.text, style: response.style ?? null, images: response.images ?? [] };
      setContext({ style: response.style ?? null, images: response.images ?? [] });
      setName(response.name);
      editor.commands.setContent(textToEditorDocument(response.text, 'prompt'), { emitUpdate: false });
      editor.commands.setTextSelection(1);
      onSavedRef.current(response); setLastSaved(response.updated_at); setDirty(false);
      setScope(null); setPreview(null); setVersions(null);
      toast.success('已恢复历史版本，恢复前的正文已保留');
    } catch (error) { toast.error(errorText(error)); }
    finally { actionLock.current = false; setRestoring(false); }
  };

  const validScope = scope && editor && scope.to <= editor.state.doc.content.size && editor.state.doc.textBetween(scope.from, scope.to, '\n') === scope.text ? scope : null;
  const transferText = validScope ? validScope.text : editor?.getText({ blockSeparator: '\n' }) ?? '';
  const transfer = async (category: 'image' | 'video' | 'audio', append: boolean) => {
    if (!editor || preview || !transferText.trim() || actionLock.current) return;
    const sourceDocument = JSON.stringify(editor.getJSON());
    const sourceContext = contextKey();
    actionLock.current = true; setHandoffBusy(true);
    try {
      if (!await save()) return;
      if (!alive.current || editor.isDestroyed) return;
      if (JSON.stringify(editor.getJSON()) !== sourceDocument || contextKey() !== sourceContext) {
        toast.error('正文已变化，请重新选择带入内容'); return;
      }
      const state = usePlaygroundStore.getState();
      const sameCategory = category === 'image' ? ['t2i', 'i2i'].includes(state.mode) : category === 'video' ? ['t2v', 'i2v', 'r2v', 'v2v'].includes(state.mode) : ['t2a', 'r2a'].includes(state.mode);
      const withImages = includeImages && context.images.length > 0 && category !== 'audio';
      const targetMode: PlaygroundMode = withImages ? category === 'image' ? 'i2i' : context.images.length > 1 ? 'r2v' : 'i2v' : sameCategory ? state.mode : category === 'image' ? 't2i' : category === 'video' ? 't2v' : 't2a';
      const targetModels = getModelsForMode(targetMode);
      let modelId = state.modelId;
      // Resolve mode defaults without changing materials, parameters, or negative prompt.
      if (!sameCategory || !targetModels.some((model) => model.id === modelId)) {
        const preferred = state.modelPreferences[targetMode];
        modelId = targetModels.find((model) => model.id === preferred)?.id ?? targetModels.find((model) => model.recommended)?.id ?? targetModels[0]?.id ?? '';
      }
      if (!modelId) { toast.error('该类别没有可用模型'); return; }
      let inputMedia = state.inputMedia;
      if (withImages) {
        await promptEditorApi.validateImages(document.id, context);
        if (!alive.current || editor.isDestroyed) return;
        if (JSON.stringify(editor.getJSON()) !== sourceDocument || contextKey() !== sourceContext) { toast.error('正文或参考图已变化，请重新带入'); return; }
        const incoming = context.images.map((image) => image.ref);
        if (mediaAction === 'append' && state.inputMedia.length && state.inputMedia.some((ref) => !incoming.includes(ref))) {
          toast.error('已有素材会改变 Image 编号，请选择替换素材，或先在创作台处理已有素材后带入'); return;
        }
        inputMedia = mediaAction === 'append' ? Array.from(new Set([...state.inputMedia, ...incoming])) : incoming;
        const config = getMediaInputConfig(targetMode, getModelMaxReferenceImages(modelId));
        if (!config || inputMedia.length > config.maxFiles) { toast.error(`目标模式／模型最多支持 ${config?.maxFiles ?? 0} 张图片，请减少参考图或在创作台选择其他模型`); return; }
        if (append && state.prompt && /(?:Image\s*\d|图像?\s*\d)/i.test(state.prompt) && mediaAction === 'replace' && JSON.stringify(state.inputMedia) !== JSON.stringify(inputMedia)) {
          toast.error('追加文字会保留旧 Image 引用，但素材已变化，请选择替换文字或先修正旧引用'); return;
        }
      }
      const text = append && state.prompt ? state.prompt + '\n' + transferText : transferText;
      const maxLength = getPromptMaxLength(modelId);
      if (text.length > maxLength) { toast.error(`提示词为 ${text.length} 字，目标输入上限为 ${maxLength} 字`, { body: '请精简正文或框选要带入的内容，未截断文本。' }); return; }
      usePlaygroundStore.setState({ mode: targetMode, modelId, prompt: text, ...(withImages ? { inputMedia } : {}) });
      setHandoff(null);
      window.location.hash = '#/playground';
      toast.success('提示词已带入创作台', { body: '选择素材和参数后，点击生成。' });
    } catch (error) { toast.error(errorText(error)); } finally { actionLock.current = false; if (alive.current) setHandoffBusy(false); }
  };

  return <div className="flex h-full min-h-0 flex-col">
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border-subtle px-5 py-3">
      <input aria-label="文档名称" maxLength={200} disabled={switching || restoring} className="min-w-0 flex-1 rounded-lg border border-border-subtle bg-surface px-3 py-2 text-sm" value={name}
        onChange={(event) => { setName(event.target.value); draft.current.name = event.target.value; setDirty(true); setEditTick((tick) => tick + 1); }} />
      <span className="text-xs text-text-muted">{saving ? '保存中…' : saveError ? '保存失败' : dirty ? '未保存' : `已保存 ${new Date(lastSaved).toLocaleTimeString()}`}</span>
      <button className={BUTTON} disabled={!editor || switching || restoring} onClick={() => { void save(true); }}><Save size={14} />保存</button>
      <button className={BUTTON} disabled={!editor?.can().undo() || switching || restoring} onClick={() => { editor?.commands.undo(); setScope(null); }} title="撤销"><Undo2 size={14} /></button>
      <button className={BUTTON} disabled={!editor?.can().redo() || switching || restoring} onClick={() => { editor?.commands.redo(); setScope(null); }} title="重做"><Redo2 size={14} /></button>
      <button className={BUTTON} disabled={switching || restoring} onClick={() => { void showHistory(); }}><History size={14} />历史</button>
      <details className="relative">
        <summary className={`${BUTTON} list-none cursor-pointer`}>用于创作台</summary>
        <div className="absolute right-0 top-full z-30 mt-1 w-48 rounded-xl border border-border-subtle bg-surface p-2 shadow-lg">
          <p className="mb-2 px-2 text-xs text-text-muted">{validScope ? '选区' : '全文'} · {transferText.length} 字</p>
          {(['image', 'video', 'audio'] as const).map((category) => <button key={category} disabled={!transferText.trim() || !!preview || switching || restoring} className="block w-full rounded-lg px-3 py-2 text-left text-xs hover:bg-hover-bg disabled:opacity-40"
            onClick={(event) => { event.currentTarget.closest('details')?.removeAttribute('open'); setMediaAction('replace'); setHandoff(category); }}>
            {{ image: '图片', video: '视频', audio: '音频' }[category]}
          </button>)}
          {preview && <p className="px-2 text-xs text-text-muted">请先接受或放弃预览</p>}
        </div>
      </details>
    </div>
    {saveError && <p role="alert" className="px-5 py-2 text-xs text-status-failed-fg">{saveError}</p>}
    <div className="flex min-h-0 flex-1 flex-col md:flex-row">
      <main className="min-h-0 min-w-0 flex-1 overflow-y-auto p-5">
        <div className="mx-auto flex min-h-full max-w-[900px] flex-col rounded-2xl border border-border-subtle bg-surface shadow-sm">
        <h2 className="border-b border-border-subtle px-6 py-3 text-sm font-medium">{preview ? 'AI 结果预览' : '正文'}</h2>
        {preview ? <><div className="px-8 pt-3"><button className={BUTTON} onClick={() => { void navigator.clipboard.writeText(preview.text).then(() => toast.success('已复制预览')).catch(() => toast.error('复制失败')); }}><Copy size={13} />复制预览</button></div><AiResultPreview purpose="prompt" text={preview.text} onAccept={() => { void accept(); }} onDiscard={() => { preview.onResolved?.(); setPreview(null); setScope(null); }} /></>
          : <EditorContent editor={editor} className="mx-auto w-full min-h-full max-w-[850px] px-8 py-8 [&_.tiptap]:min-h-[60vh] [&_.tiptap]:whitespace-pre-wrap [&_.tiptap]:break-words [&_.tiptap]:outline-none [&_.tiptap]:text-[1rem] [&_.tiptap]:leading-8 [&_.tiptap_p]:m-0" />}
        </div>
      </main>
      <aside className="flex h-[450px] shrink-0 flex-col overflow-y-auto border-t border-border-subtle md:h-auto md:w-[340px] md:border-l md:border-t-0">
        <PromptContextInput value={context} disabled={switching || restoring || handoffBusy} onChange={(value) => { draft.current.style = value.style; draft.current.images = value.images; setContext(value); setDirty(true); setEditTick((tick) => tick + 1); }} />
        {/* min-h-0：窄窗口下这栏只有 450px，面板自己滚，动作按钮才不会被挤到折叠线以下。 */}
        <div className="flex min-h-0 flex-1 flex-col"><AiPanel promptContext={context} purpose="prompt" editor={editor} projectId={document.id} onPreview={setPreview} scope={scope} onScopeChange={setScope} /></div>
      </aside>
    </div>
    <footer className="border-t border-border-subtle px-5 py-2 text-xs text-text-muted">{draft.current.text.length} 字 · 独立文档</footer>
    {versions && <div className="fixed inset-0 z-50 flex items-center justify-center bg-overlay p-6" onClick={() => setVersions(null)}>
      <section role="dialog" aria-modal="true" aria-label="文档历史" className="flex max-h-[80vh] w-full max-w-2xl flex-col rounded-2xl border border-border-subtle bg-surface p-5" onClick={(event) => event.stopPropagation()}>
        <div className="mb-4 flex items-center justify-between"><h2>文档历史</h2><button aria-label="关闭" onClick={() => setVersions(null)}><X size={18} /></button></div>
        <div className="overflow-auto">{versions.length ? versions.map((version) => <details key={version.id} className="mb-3 rounded-xl border border-border-subtle p-3"><summary className="cursor-pointer text-sm">{new Date(version.created_at).toLocaleString()} · {version.name} · {version.text.length} 字 · {version.images?.length ?? 0} 张图{version.style ? ` · ${version.style.name}` : ''}</summary><pre className="my-3 max-h-48 overflow-auto whitespace-pre-wrap text-xs">{version.text || '空白文档'}</pre><button className={BUTTON} disabled={restoring} onClick={() => { void restore(version); }}>恢复此版本</button></details>) : <p className="text-sm text-text-muted">尚无保存版本</p>}</div>
      </section>
    </div>}
    {handoff && <div className="fixed inset-0 z-50 flex items-center justify-center bg-overlay p-6">
      <section role="dialog" aria-modal="true" aria-label="带入创作台" className="w-full max-w-md rounded-2xl border border-border-subtle bg-surface p-6">
        <h2 className="mb-2 font-semibold">用于创作台</h2>
        {context.images.length > 0 && handoff !== 'audio' && <div className="mb-3 space-y-2 text-xs"><label className="block"><input type="checkbox" checked={includeImages} onChange={(event) => setIncludeImages(event.target.checked)} /> 同时带入 {context.images.length} 张参考图片</label>{includeImages && <><p>目标：{handoff === 'image' ? '图片编辑' : context.images.length > 1 ? '参考生视频' : '图生视频'}；按 Image 1 开始的顺序带入。</p>{usePlaygroundStore.getState().inputMedia.length > 0 && <label>创作台已有素材：<select value={mediaAction} onChange={(event) => setMediaAction(event.target.value as 'replace' | 'append')} className="ml-2 rounded border bg-surface p-1"><option value="replace">替换已有素材</option><option value="append">追加（编号冲突时阻止）</option></select></label>}{context.images.map((image, index) => <p key={image.ref}>Image {index + 1} · {image.name}</p>)}</>}</div>}<p className="mb-4 text-sm text-text-muted">{handoffBusy ? '正在检查参考图片…' : ''}本次带入{validScope ? '选区' : '全文'}，共 {transferText.length} 字。创作台已有文字时可替换或追加；取消不做修改。</p>
        <div className="flex justify-end gap-2"><button disabled={handoffBusy} className={BUTTON} onClick={() => setHandoff(null)}>取消</button><button disabled={handoffBusy} className={BUTTON} onClick={() => { void transfer(handoff, true); }}>追加</button><button disabled={handoffBusy} className={BUTTON} onClick={() => { void transfer(handoff, false); }}>替换</button></div>
      </section>
    </div>}
  </div>;
});

export default function PromptEditorPage() {
  const [documents, setDocuments] = useState<PromptDocument[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [switching, setSwitching] = useState(false);
  const editorRef = useRef<EditorHandle>(null);
  const switchingLock = useRef(false);
  const loadEpoch = useRef(0);
  const active = documents.find((document) => document.id === activeId);
  const load = useCallback(async () => {
    const epoch = ++loadEpoch.current;
    setLoading(true); setError('');
    try {
      let items = await promptEditorApi.list();
      if (epoch !== loadEpoch.current) return;
      if (!items.length) items = [await promptEditorApi.create()];
      if (epoch !== loadEpoch.current) return;
      let remembered: string | null = null;
      try { remembered = localStorage.getItem(LAST_DOCUMENT); } catch { /* Optional navigation preference. */ }
      setDocuments(items); setActiveId(items.some((item) => item.id === remembered) ? remembered : items[0].id);
    } catch (reason) { if (epoch === loadEpoch.current) setError(errorText(reason)); }
    finally { if (epoch === loadEpoch.current) setLoading(false); }
  }, []);
  useEffect(() => { void load(); return () => { loadEpoch.current += 1; }; }, [load]);
  useEffect(() => { if (activeId) try { localStorage.setItem(LAST_DOCUMENT, activeId); } catch { /* Content is stored on the backend. */ } }, [activeId]);
  const switchDocument = async (id?: string) => {
    if (switchingLock.current) return;
    switchingLock.current = true; setSwitching(true);
    try {
      if (editorRef.current && !await editorRef.current.save(true)) return;
      const next = id ? await promptEditorApi.get(id) : await promptEditorApi.create();
      setDocuments((items) => [next, ...items.filter((item) => item.id !== next.id)]);
      setActiveId(next.id);
    } catch (reason) { toast.error(errorText(reason)); }
    finally { switchingLock.current = false; setSwitching(false); }
  };
  const onSaved = useCallback((document: PromptDocument) => setDocuments((items) => items.map((item) => item.id === document.id ? document : item)), []);
  return <div className="script-editor-theme flex h-full min-h-0 flex-col bg-bg-base text-foreground">
    <header className="flex shrink-0 flex-wrap items-center gap-3 border-b border-border-subtle px-5 py-4">
      <h1 className="font-display text-xl font-semibold">提示词编辑</h1>
      <select aria-label="切换文档" value={activeId ?? ''} disabled={switching || loading} className="min-w-0 max-w-xs rounded-lg border border-border-subtle bg-surface px-3 py-2 text-xs" onChange={(event) => { void switchDocument(event.target.value); }}>
        {!activeId && <option value="">{loading ? '加载中…' : '选择文档'}</option>}{documents.map((document) => <option key={document.id} value={document.id}>{document.name}</option>)}
      </select>
      <button className={BUTTON} disabled={switching || loading || !!error} onClick={() => { void switchDocument(); }}><Plus size={14} />新建</button>
      <span className="text-xs text-text-muted">Skill 可选 · 自由创作</span>
    </header>
    {loading ? <p className="p-8 text-sm text-text-muted">加载文档…</p> : error ? <div className="p-8"><p role="alert" className="mb-3 text-sm text-status-failed-fg">{error}</p><button className={BUTTON} onClick={() => { void load(); }}>重新加载</button></div> : active && <div className="min-h-0 flex-1"><PromptDocumentEditor key={active.id} ref={editorRef} document={active} onSaved={onSaved} switching={switching} /></div>}
  </div>;
}
