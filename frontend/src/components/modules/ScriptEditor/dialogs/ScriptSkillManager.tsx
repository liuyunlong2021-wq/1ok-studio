'use client';

import { selectableSkills } from '@/lib/skillSelection';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Copy, Download, Loader2, Search, Upload, X } from 'lucide-react';
import { api } from '@/lib/api';
import { scriptEditorApi, type ScriptSkill } from '@/lib/scriptEditorApi';

function errorText(error: unknown): string {
  const detail = (error as { response?: { data?: { detail?: unknown } } })?.response?.data?.detail;
  return typeof detail === 'string' ? detail : error instanceof Error ? error.message : '操作失败，请重试';
}

function normalizedContent(content: string) {
  return content.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim();
}

function importedName(content: string, filename: string) {
  const frontmatter = content.replace(/^\uFEFF/, '').match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
  const name = frontmatter?.match(/^name:\s*(.+)$/m)?.[1]?.trim().replace(/^(['"])(.*)\1$/, '$2');
  return name || content.match(/^#\s+(.+)$/m)?.[1]?.trim() || filename.replace(/\.(md|markdown|txt)$/i, '');
}

function uniqueName(name: string, items: ScriptSkill[]) {
  let candidate = `${name}（副本）`;
  let count = 2;
  while (items.some((item) => item.name.trim().toLowerCase() === candidate.toLowerCase())) {
    candidate = `${name}（副本${count++}）`;
  }
  return candidate;
}

const BUTTON = 'rounded-lg border border-border-subtle px-3 py-2 text-xs text-foreground hover:bg-hover-bg disabled:opacity-40';

export default function ScriptSkillManager({ activeId, initialFile, onChange, onClose, kind = 'script' }: {
  kind?: 'script' | 'all';
  activeId: string;
  initialFile?: File;
  onChange: (items: ScriptSkill[], selectedId?: string) => void;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const replaceRef = useRef<HTMLInputElement>(null);
  const initialActiveId = useRef(activeId).current;
  const [items, setItems] = useState<ScriptSkill[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [content, setContent] = useState('');
  const [files, setFiles] = useState<Record<string, string> | undefined>();
  const [entry, setEntry] = useState('SKILL.md');
  const [activeFile, setActiveFile] = useState('SKILL.md');
  const folderRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [uploadDraft, setUploadDraft] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const selected = items.find((item) => item.id === selectedId);
  const dirty = selected ? (name !== selected.name || content !== (selected.files?.[selected.entry ?? 'SKILL.md'] ?? selected.content) || JSON.stringify(files) !== JSON.stringify(selected.files)) : !!(name || content);
  const matchingName = items.filter((item) => item.id !== selectedId && item.name.trim().toLowerCase() === name.trim().toLowerCase());
  const sameContent = uploadDraft && content.trim() ? items.find((item) => normalizedContent(item.content) === normalizedContent(content)) : undefined;
  const unchangedLegacyName = !!selected && name.trim() === selected.name.trim();
  const nameConflict = matchingName.length > 0 && !unchangedLegacyName;

  const loadItem = (item?: ScriptSkill) => {
    setSelectedId(item?.id ?? null);
    setName(item?.name ?? '');
    const entry = item?.entry ?? 'SKILL.md';
    setEntry(entry); setActiveFile(entry); setFiles(item?.files);
    setContent(item?.files?.[entry] ?? item?.content ?? '');
    setUploadDraft(false);
    setError('');
    setNotice('');
  };

  const canLeave = () => !busy && (!dirty || window.confirm('有未保存的修改，确定放弃吗？'));
  const close = () => { if (canLeave()) onClose(); };

  useEffect(() => {
    const dialog = dialogRef.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const list = await scriptEditorApi.listScriptSkills(kind, true);
        let text: string | null = null;
        if (initialFile?.name.toLowerCase().endsWith('.zip')) {
          const uploaded = await api.uploadSkillPackage(initialFile);
          const refreshed = await scriptEditorApi.listScriptSkills(kind, true);
          if (cancelled) return;
          setItems(refreshed); loadItem(refreshed.find((item) => item.id === (uploaded.id === 'builtin:engineering-screenplay' ? 'builtin-engineering' : uploaded.id)));
          onChange(refreshed.filter((item) => !item.hidden), (uploaded.id === 'builtin:engineering-screenplay' ? 'builtin-engineering' : uploaded.id));
          setNotice(uploaded.reused ? '相同内容已存在，已复用已有 Skill。' : '完整 Skill 包已上传。'); return;
        }
        text = initialFile ? await initialFile.text() : null;
        if (cancelled) return;
        setItems(list);
        if (text !== null && !text.trim()) throw new Error('上传的文件内容为空');
        if (text !== null && initialFile) {
          setName(importedName(text, initialFile.name));
          setContent(text.replace(/^\uFEFF/, ''));
          setUploadDraft(true);
          setNotice(`已读取 ${initialFile.name}，确认名称与内容后保存。`);
        } else {
          loadItem(list.find((item) => item.id === initialActiveId) ?? list[0]);
        }
      } catch (reason) {
        if (!cancelled) setError(errorText(reason));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    return () => { cancelled = true; };
  }, [initialActiveId, initialFile, kind]);

  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const refresh = async (selectedForPanel?: string) => {
    const list = await scriptEditorApi.listScriptSkills(kind, true);
    setItems(list);
    onChange(list.filter((item) => !item.hidden), selectedForPanel);
    window.dispatchEvent(new Event('script-skills-changed'));
    return list;
  };

  const operate = async (action: () => Promise<void>) => {
    setBusy(true);
    setError('');
    setNotice('');
    try { await action(); } catch (reason) { setError(errorText(reason)); } finally { setBusy(false); }
  };

  const save = (updateTarget?: ScriptSkill) => {
    if (busy || !name.trim() || !content.trim()) return;
    if (updateTarget && !window.confirm(`确认用当前内容更新“${updateTarget.name}”？其他项目之后也会使用新版。`)) return;
    void operate(async () => {
      const target = updateTarget ?? selected;
      const saved = target
        ? await scriptEditorApi.updateScriptSkill(target.id, updateTarget ? target.name : name.trim(), content, target?.kind ?? 'script', files ? { ...files, [entry]: content } : undefined)
        : await scriptEditorApi.createScriptSkill(name.trim(), content, 'script', files ? { ...files, [entry]: content } : undefined);
      const list = await refresh(target ? undefined : saved.id);
      loadItem(list.find((item) => item.id === saved.id));
      setNotice(saved.reused ? '相同内容已存在，已复用已有 Skill。' : '已保存，后续请求使用新版内容。');
    });
  };

  const upload = async (file?: File, replace = false) => {
    if (!file || !canLeave()) return;
    await operate(async () => {
      if (file.name.toLowerCase().endsWith('.zip')) { const uploaded = await api.uploadSkillPackage(file); const list = await refresh((uploaded.id === 'builtin:engineering-screenplay' ? 'builtin-engineering' : uploaded.id)); loadItem(list.find((item) => item.id === (uploaded.id === 'builtin:engineering-screenplay' ? 'builtin-engineering' : uploaded.id))); setNotice(uploaded.reused ? '相同内容已存在，已复用已有 Skill。' : '完整 Skill 包已上传。'); return; }
      const text = (await file.text()).replace(/^\uFEFF/, '');
      if (!text.trim()) throw new Error('上传的文件内容为空');
      if (!replace) {
        setSelectedId(null); setFiles(undefined); setEntry('SKILL.md'); setActiveFile('SKILL.md');
        setName(importedName(text, file.name));
        setUploadDraft(true);
      }
      setContent(text);
      setNotice(replace ? '已载入新文件；点击保存后更新当前 Skill。' : '已读取文件，确认名称与内容后保存。');
    });
  };

  const copy = () => {
    if (busy) return;
    setName(uniqueName(name || 'Skill', items));
    setSelectedId(null);
    setUploadDraft(false);
    setError('');
    setNotice('已创建副本草稿，可以修改名称和内容后保存。');
  };

  const useExisting = (item: ScriptSkill) => {
    if (busy || item.hidden || item.validation_error) return;
    // Importing identical content needs no write; selecting it resolves the upload draft.
    if (!sameContent && !canLeave()) return;
    onChange(items.filter((entry) => !entry.hidden), item.id);
    onClose();
  };

  const remove = () => {
    if (!selected || !canLeave()) return;
    if (!window.confirm((selected.is_builtin || selected.files) ? `隐藏“${selected.name}”？可在管理列表中恢复。` : `删除“${selected.name}”？此操作不能撤销，已生成的剧本会保留。`)) return;
    void operate(async () => {
      await scriptEditorApi.deleteScriptSkill(selected.id);
      const list = await refresh();
      loadItem((selected.is_builtin || selected.files) ? list.find((item) => item.id === selected.id) : list[0]);
      setNotice((selected.is_builtin || selected.files) ? '已隐藏，可点击恢复显示。' : '已删除。');
    });
  };

  const exportFile = () => {
    void operate(async () => {
    const blob = selected?.files ? await scriptEditorApi.exportScriptSkill(selected.id) : new Blob([content], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${(name || 'Skill').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')}.${selected?.files ? 'zip' : 'md'}`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
  };

  const choices = selectableSkills(items);
  const skillLabel = (item: ScriptSkill) => {
    const choice = choices.find((candidate) => candidate.aliases.includes(item.id));
    return choice ? `${choice.displayName}${choice.aliases.length > 1 ? ` · 同内容副本 ${choice.aliases.indexOf(item.id) + 1}/${choice.aliases.length}` : ''}` : item.name;
  };
  const visible = items.filter((item) => (filter === 'all' || (filter === 'hidden' ? item.hidden : filter === 'builtin' ? item.is_builtin : !item.is_builtin)) && item.name.toLowerCase().includes(query.toLowerCase()));

  return createPortal(
    <dialog ref={dialogRef} aria-labelledby="script-skill-manager-title" onCancel={(event) => { event.preventDefault(); close(); }} className="fixed inset-0 m-auto h-[min(760px,90dvh)] w-[min(1040px,94vw)] overflow-hidden rounded-2xl border border-border-subtle bg-surface p-0 text-foreground shadow-2xl backdrop:bg-black/40">
      <div className="flex h-full flex-col">
        <header className="flex shrink-0 items-center justify-between gap-3 border-b border-border-subtle p-5">
          <div><h2 id="script-skill-manager-title" className="font-semibold">Skill 管理</h2><p className="mt-1 text-xs text-text-muted">本机共享 · 修改影响后续请求</p></div>
          <div className="flex items-center gap-2"><button type="button" disabled={busy || loading} onClick={() => fileRef.current?.click()} className={BUTTON}><Upload size={13} className="mr-1 inline" />上传</button>{kind === 'all' && <button type="button" disabled={busy || loading} className={BUTTON} onClick={() => folderRef.current?.click()}>上传文件夹</button>}<button type="button" onClick={close} disabled={busy} aria-label="关闭 Skill 管理" className={BUTTON}><X size={16} /></button></div>
        </header>
        <div className="grid min-h-0 flex-1 grid-cols-[220px_minmax(0,1fr)] max-sm:grid-cols-[140px_minmax(0,1fr)]">
          <aside className="flex min-h-0 flex-col border-r border-border-subtle p-3">
            <label className="flex items-center gap-2 rounded-lg border border-border-subtle px-2 py-2"><Search size={13} className="shrink-0 text-text-muted" /><input aria-label="搜索 Skill" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索名称" className="min-w-0 w-full bg-transparent text-xs outline-none" /></label>
            <select aria-label="筛选 Skill" value={filter} onChange={(event) => setFilter(event.target.value)} className="mt-2 rounded-lg border border-border-subtle bg-surface px-2 py-2 text-xs"><option value="all">全部</option><option value="custom">自定义</option><option value="builtin">内置</option><option value="hidden">已隐藏</option></select>
            <div className="mt-3 min-h-0 flex-1 space-y-1 overflow-auto">
              {loading && <p className="p-2 text-xs text-text-muted">加载中…</p>}
              {visible.map((item) => <button key={item.id} type="button" disabled={busy} onClick={() => { if (canLeave()) loadItem(item); }} className={`w-full rounded-lg p-3 text-left text-xs ${item.id === selectedId ? 'bg-primary/10 ring-1 ring-primary/30' : 'hover:bg-hover-bg'} ${item.hidden ? 'opacity-60' : ''}`}>
                <div className="break-words font-medium">{skillLabel(item)}</div><div className="mt-1 text-[0.625rem] text-text-muted">{item.is_builtin ? '内置' : '自定义'}{item.hidden ? ' · 已隐藏' : ''}{item.validation_error ? ' · 需修复' : ''}{item.id === activeId && !item.hidden ? ' · 使用中' : ''}</div>
                {item.updated_at && <div className="mt-1 text-[0.625rem] text-text-muted">{new Date(item.updated_at * 1000).toLocaleString('zh-CN')}</div>}
              </button>)}
              {!loading && !visible.length && <p className="p-2 text-xs text-text-muted">没有匹配的 Skill</p>}
            </div>
          </aside>
          <section className="flex min-h-0 flex-col gap-3 p-5 max-sm:p-3">
            <label className="text-xs text-text-secondary">名称<input value={name} disabled={busy || loading || selected?.readonly} onChange={(event) => setName(event.target.value)} className="mt-1 block w-full rounded-lg border border-border-subtle bg-input-bg px-3 py-2 text-sm text-foreground" /></label>
            {selected?.is_builtin && <p className="text-xs text-text-muted">{selected.readonly ? '此内置 Skill 由应用执行，说明只读；可隐藏或恢复显示。' : '直接保存为个人版本，应用升级保留修改；可恢复内置默认。'}</p>}
            <label className="flex min-h-0 flex-1 flex-col text-xs text-text-secondary">{files ? '规则文件' : '完整内容'}{files && <select className="mt-1 rounded border bg-surface p-2" value={activeFile} onChange={(event) => setActiveFile(event.target.value)}>{Object.keys(files).map((path) => <option key={path} value={path}>{path}{path === entry ? ' · 主规则' : ''}</option>)}</select>}<textarea value={activeFile === entry ? content : files?.[activeFile] ?? ''} disabled={busy || loading || selected?.readonly} onChange={(event) => { if (activeFile === entry) setContent(event.target.value); else setFiles((previous) => ({ ...previous, [activeFile]: event.target.value })); }} spellCheck={false} className="mt-1 min-h-[100px] flex-1 resize-none rounded-lg border border-border-subtle bg-input-bg p-3 font-mono text-xs leading-relaxed text-foreground" /></label>
            {sameContent && <div className="rounded-lg bg-primary/10 p-3 text-xs">相同内容已存在：{sameContent.name}<div className="mt-2 flex flex-wrap gap-2">{!sameContent.hidden && <button type="button" className={BUTTON} onClick={() => useExisting(sameContent)}>选用已有 Skill</button>}<button type="button" className={BUTTON} onClick={copy}>另存一份</button></div></div>}
            {nameConflict && !sameContent && <div className="rounded-lg border border-border-subtle p-3 text-xs">已有同名 Skill，请选择更新或另存。<div className="mt-2 flex flex-wrap gap-2">{uploadDraft && matchingName.filter((item) => !item.is_builtin).map((item, index) => <button type="button" key={item.id} disabled={busy} className={BUTTON} onClick={() => save(item)}>更新已有{matchingName.length > 1 ? `（${index + 1}）` : ''}</button>)}<button type="button" className={BUTTON} onClick={copy}>另存一份</button></div></div>}
            {selected?.validation_error && <p role="alert" className="text-xs text-red-400">需修复：{selected.validation_error}。可编辑主规则或附属文件后保存。</p>}
            {notice && <p role="status" className="text-xs text-primary">{notice}</p>}
            {error && <p role="alert" className="text-xs text-red-400">{error}</p>}
            <div className="flex flex-wrap items-center gap-2">
              <button type="button" disabled={busy || loading || !content.trim() || selected?.readonly} onClick={copy} className={BUTTON}><Copy size={13} className="mr-1 inline" />复制</button>
              <button type="button" disabled={busy || loading || !content.trim() || selected?.readonly || (!!selected?.files && dirty)} onClick={exportFile} className={BUTTON}><Download size={13} className="mr-1 inline" />导出</button>
              {selected && !selected.is_builtin && <button type="button" disabled={busy} onClick={() => replaceRef.current?.click()} className={BUTTON}>重新上传更新</button>}
              {selected && (selected.hidden ? <button type="button" disabled={busy} className={BUTTON} onClick={() => void operate(async () => { await scriptEditorApi.restoreScriptSkill(selected.id); const list = await refresh(); loadItem(list.find((item) => item.id === selected.id)); setNotice('已恢复显示。'); })}>恢复显示</button> : <button type="button" disabled={busy} onClick={remove} className={`${BUTTON} text-red-400`}>{selected.is_builtin || selected.files ? '隐藏' : '删除'}</button>)}
              {selected?.is_builtin && !selected.readonly && <button type="button" disabled={busy} className={BUTTON} onClick={() => { if (canLeave() && window.confirm('恢复内置默认？当前修改会保留备份。')) void operate(async () => { await scriptEditorApi.resetScriptSkill(selected.id); const list = await refresh(); loadItem(list.find((item) => item.id === selected.id)); setNotice('已恢复默认，修改备份已保留。'); }); }}>恢复内置默认</button>}
              {selected?.has_backup && <button type="button" disabled={busy} className={BUTTON} onClick={() => { if (canLeave()) void operate(async () => { await scriptEditorApi.resetScriptSkill(selected.id, true); const list = await refresh(); loadItem(list.find((item) => item.id === selected.id)); setNotice('已恢复上一份修改备份。'); }); }}>恢复修改备份</button>}
            </div>
          </section>
        </div>
        <footer className="flex shrink-0 items-center justify-end gap-2 border-t border-border-subtle p-4">
          {busy && <Loader2 size={15} className="animate-spin" />}
          <button type="button" disabled={busy || loading || selected?.readonly || !dirty} className={BUTTON} onClick={() => { if (canLeave()) loadItem(selected ?? items.find((item) => item.id === activeId) ?? items[0]); }}>取消修改</button>
          {selected && !selected.hidden && <button type="button" disabled={busy || loading || dirty || !!selected.validation_error} className={BUTTON} onClick={() => useExisting(selected)}>使用此 Skill</button>}
          <button type="button" disabled={busy || loading || selected?.readonly || !dirty || !name.trim() || !content.trim() || nameConflict || !!sameContent} onClick={() => save()} className="rounded-lg bg-primary px-4 py-2 text-xs font-semibold text-on-accent disabled:opacity-40">保存</button>
          <button type="button" disabled={busy} onClick={close} className={BUTTON}>关闭</button>
        </footer>
        <input ref={fileRef} type="file" accept={kind === 'all' ? '.md,.markdown,.txt,.zip' : '.md,.markdown,.txt'} className="hidden" onChange={(event) => { void upload(event.target.files?.[0]); event.target.value = ''; }} />
        <input ref={folderRef} type="file" multiple {...({ webkitdirectory: '' } as Record<string, string>)} className="hidden" onChange={(event) => { const picked = Array.from(event.target.files ?? []); if (picked.length && canLeave()) void operate(async () => { const uploaded = await api.uploadSkillFolder(picked); const list = await refresh((uploaded.id === 'builtin:engineering-screenplay' ? 'builtin-engineering' : uploaded.id)); loadItem(list.find((item) => item.id === (uploaded.id === 'builtin:engineering-screenplay' ? 'builtin-engineering' : uploaded.id))); setNotice(uploaded.reused ? '相同内容已存在，已复用已有 Skill。' : '完整 Skill 文件夹已上传。'); }); event.target.value = ''; }} />
        <input ref={replaceRef} type="file" accept=".md,.markdown,.txt" className="hidden" onChange={(event) => { void upload(event.target.files?.[0], true); event.target.value = ''; }} />
      </div>
    </dialog>, document.body,
  );
}
