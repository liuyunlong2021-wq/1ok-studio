'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { EditorContent } from '@tiptap/react';
import { PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen, WifiOff, RotateCcw, X, Save, Loader2 } from 'lucide-react';
import { useEditorStore } from '@/store/editorStore';
import { useProjectStore } from '@/store/projectStore';
import { useEditorSetup } from './hooks/useEditorSetup';
import FormatToolbar from './toolbar/FormatToolbar';
import { usePasteHandler } from './hooks/usePasteHandler';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts';
import { useAutoSave } from './hooks/useAutoSave';
import { useContinuityCheck } from './hooks/useContinuityCheck';
import { useSceneFolding } from './hooks/useSceneFolding';
import { useViewMode } from './hooks/useViewMode';
import { useOfflineCache } from './hooks/useOfflineCache';
import { useDerivation } from './hooks/useDerivation';
import { PasteHintBar } from './components/PasteHintBar';
import AiResultPreview, { applyAiPreview, textToEditorDocument } from './components/AiResultPreview';
import { ShortcutHelpPanel } from './components/ShortcutHelpPanel';
import { ContinuityIndicator } from './components/ContinuityIndicator';
import RightPanelContainer from './panels';
import type { AiPreview } from './panels/AiPanel';
import type { AiScope } from './panels/AiPanel';
import LeftSidebar from './sidebar';
import StoryboardView from './views/StoryboardView';
import ExportDialog from './dialogs/ExportDialog';
import { scriptEditorApi } from '@/lib/scriptEditorApi';
import { scriptTextOf } from './documentText';
import { applyAiScope } from './extensions';
import { toast } from '@/store/toastStore';

export interface ScriptEditorShellProps {
  mode?: 'full' | 'embedded' | 'focus';
  projectId?: string;
  initialContent?: string | Record<string, unknown> | null;
  onExtractEntities?: (text: string) => Promise<void> | void;
}

export default function ScriptEditorShell({
  mode = 'full',
  projectId,
  initialContent,
  onExtractEntities,
}: ScriptEditorShellProps) {
  const t = useTranslations('scriptEditor');
  const currentProject = useProjectStore((s) => s.currentProject);
  const projects = useProjectStore((s) => s.projects);
  const editorProjectId = useEditorStore((s) => s.projectId);
  // 首页编辑器没有 URL projectId；当只有一个项目时直接绑定它，避免保存按钮失效。
  const effectiveProjectId = projectId ?? currentProject?.id ?? editorProjectId ?? (projects.length === 1 ? projects[0].id : undefined);
  const hydrationProject = projectId
    ? (currentProject?.id === projectId ? currentProject : projects.find((item) => item.id === projectId) ?? null)
    : (currentProject ?? (projects.length === 1 ? projects[0] : null));
  const projectText = hydrationProject
    ? ((hydrationProject as typeof hydrationProject & { original_text?: string }).originalText ||
      (hydrationProject as typeof hydrationProject & { original_text?: string }).original_text || '')
    : '';
  const { editor, isReady } = useEditorSetup({ content: initialContent ?? projectText });
  useDerivation(editor);
  const loadedProjectRef = useRef<string | null>(null);
  const hydratedTextRef = useRef<string | null>(null);
  const loadedDocumentRef = useRef<string | null>(null);
  const isDirty = useEditorStore((s) => s.isDirty);
  useEffect(() => {
    const store = useEditorStore.getState();
    store.setProjectId(projectId ?? null);
    store.setDirty(false);
    store.setLastSavedAt(null);
  }, [projectId]);
  useEffect(() => {
    if (!editor || !effectiveProjectId) return;
    let cancelled = false;
    loadedDocumentRef.current = null;

    scriptEditorApi.loadDocument(effectiveProjectId)
      .then((document) => {
        if (cancelled || useEditorStore.getState().isDirty || !document.content?.length) return;
        loadedDocumentRef.current = effectiveProjectId;
        loadedProjectRef.current = effectiveProjectId;
        hydratedTextRef.current = projectText;
        editor.commands.setContent(document);
        useEditorStore.getState().setDirty(false);
        useEditorStore.getState().updateDerivation({ wordCount: scriptTextOf(editor).length });
      })
      .catch((error) => console.error('[ScriptEditor] Failed to load saved document:', error));

    return () => { cancelled = true; };
  }, [editor, effectiveProjectId, projectText]);
  useEffect(() => {
    if (!editor || !hydrationProject?.id) return;
    if (loadedDocumentRef.current === hydrationProject.id) return;
    const projectData = hydrationProject as typeof hydrationProject & { original_text?: string };
    const text = projectData.originalText || projectData.original_text || '';
    const projectChanged = loadedProjectRef.current !== hydrationProject.id;
    const textChanged = hydratedTextRef.current !== text;
    if (!projectChanged && (!textChanged || isDirty)) return;
    loadedProjectRef.current = hydrationProject.id;
    hydratedTextRef.current = text;
    if (!text.trim()) {
      editor.commands.clearContent();
      useEditorStore.getState().setDirty(false);
      return;
    }
    editor.commands.setContent(textToEditorDocument(text));
    useEditorStore.getState().setDirty(false);
    useEditorStore.getState().updateDerivation({ wordCount: text.length });
  }, [editor, hydrationProject, isDirty]);
  const { showHint, analysis, applyFormatting, dismissHint } = usePasteHandler(editor);
  const { showShortcutHelp, closeShortcutHelp } = useKeyboardShortcuts(editor);
  const continuityReport = useContinuityCheck(editor);
  const { enabled: foldingEnabled, isAllExpanded } = useSceneFolding(editor);
  const { mode: viewMode, setMode: setViewMode, isReadOnly, showToolbar, showSidebars } = useViewMode();
  const { hasNewerLocal, restoreFromLocal, dismissLocalRestore, isOffline } = useOfflineCache(effectiveProjectId, editor);
  const handleMissingProject = useCallback(() => useEditorStore.getState().setActiveRightPanel('pipeline'), []);
  const { save } = useAutoSave(editor, effectiveProjectId ?? null, handleMissingProject);

  const lastSavedAt = useEditorStore((s) => s.lastSavedAt);
  const wordCount = useEditorStore((s) => s.wordCount);
  const derivedScenes = useEditorStore((s) => s.derivedScenes);
  const currentFormat = useEditorStore((s) => s.currentFormat);
  const currentRendering = useEditorStore((s) => s.currentRendering);
  const leftCollapsed = useEditorStore((s) => s.leftSidebarCollapsed);
  const rightCollapsed = useEditorStore((s) => s.rightSidebarCollapsed);
  const toggleLeft = useEditorStore((s) => s.toggleLeftSidebar);
  const toggleRight = useEditorStore((s) => s.toggleRightSidebar);
  const [showExport, setShowExport] = useState(false);
  const [aiPreview, setAiPreview] = useState<AiPreview | null>(null);
  /** AI 修改的作用范围；null = 全文。放在这里是因为编辑器要拿它画高亮。 */
  const [aiScope, setAiScope] = useState<AiScope | null>(null);
  const [extractingEntities, setExtractingEntities] = useState(false);
  const showLeft = mode === 'full' && !leftCollapsed && showSidebars;
  const showRight = mode === 'full' && !rightCollapsed && showSidebars;
  const hideAllSidebars = mode === 'focus' || viewMode === 'focus';
  const hideLeftOnly = mode === 'embedded';

  const handleShotClick = useCallback((shotId: string) => {
    setViewMode('edit');
    if (editor) {
      const { doc } = editor.state;
      let targetPos: number | null = null;
      doc.descendants((node, pos) => {
        if (node.type.name === 'shotBlock' && node.attrs?.id === shotId) {
          targetPos = pos;
          return false;
        }
      });
      if (targetPos !== null) {
        editor.commands.setTextSelection(targetPos);
        editor.commands.scrollIntoView();
      }
    }
  }, [editor, setViewMode]);

  const acceptAiPreview = useCallback(() => {
    if (!editor || !aiPreview) return;
    // 预览期间正文被改过 → 位置已经不可信。宁可让人重新框，也不能改错地方。
    if (aiPreview.range && aiScope) {
      const current = editor.state.doc.textBetween(aiPreview.range.from, aiPreview.range.to, '\n');
      if (current !== aiScope.text) {
        toast.error('原文已改动，作用范围失效', { body: '请重新框选要改的内容，再看一遍结果。' });
        setAiPreview(null);
        setAiScope(null);
        return;
      }
    }
    applyAiPreview(editor, aiPreview);
    setAiPreview(null);
    setAiScope(null);
    // 编辑器文档与 `script.original_text` 是两个真相源，而分镜生成 / 提取实体 /
    // 「查看脚本」读的是后者。不在这里落盘的话，用户接受完直接去生成分镜就会
    // 拿到老版本 —— 自动保存要等 30 秒，而且只在 dirty 时才跑。
    void save(false);
  }, [aiPreview, aiScope, editor, save]);

  // 把作用范围画进正文：淡紫高亮的那一段，就是这次 AI 会改的地方。
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    applyAiScope(editor.view, aiScope ? { from: aiScope.from, to: aiScope.to } : null);
  }, [editor, aiScope]);

  return (
    <div className="script-editor-theme flex h-full w-full flex-col overflow-hidden bg-bg-base text-foreground">
      {/* Format Toolbar */}
      {!hideAllSidebars && showToolbar && (
        <FormatToolbar editor={editor} viewMode={viewMode} onViewModeChange={setViewMode} onExport={() => setShowExport(true)} />
      )}

      {/* Top Toolbar */}
      {!hideAllSidebars && showToolbar && (
        <div className="flex h-12 shrink-0 items-center justify-between border-b border-white/10 px-4">
          <div className="flex items-center gap-3">
            {mode === 'full' && (
              <button
                type="button"
                onClick={toggleLeft}
                className="text-text-muted hover:text-foreground transition-colors"
                aria-label="Toggle left sidebar"
              >
                {leftCollapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
              </button>
            )}
            <span className="text-sm font-medium text-foreground">
              {t('shell.title')}
            </span>
            {projectId && (
              <span className="text-xs text-text-muted">{projectId}</span>
            )}
          </div>
          <div className="flex items-center gap-3">
            <span className="text-xs text-text-muted">
              {isDirty ? t('status.unsaved') : lastSavedAt ? t('status.savedAt', { time: lastSavedAt.toLocaleTimeString() }) : ''}
            </span>
            <button type="button" onClick={() => effectiveProjectId ? save(true) : useEditorStore.getState().setActiveRightPanel('pipeline')} disabled={effectiveProjectId ? !isDirty : false} title={effectiveProjectId ? '保存并创建版本快照' : '请先关联项目'} className="flex items-center gap-1 rounded px-2 py-1 text-xs text-text-secondary hover:bg-hover-bg disabled:opacity-40"><Save size={13} />{effectiveProjectId ? '保存' : '关联项目后保存'}</button>
            {onExtractEntities && <button type="button" onClick={async () => { if (!editor || !scriptTextOf(editor).trim() || extractingEntities) return; setExtractingEntities(true); try { await save(false); await onExtractEntities(scriptTextOf(editor)); } finally { setExtractingEntities(false); } }} disabled={!editor || !scriptTextOf(editor).trim() || extractingEntities} className="flex items-center gap-1 rounded px-2 py-1 text-xs text-text-secondary hover:bg-hover-bg disabled:opacity-40">{extractingEntities && <Loader2 size={12} className="animate-spin" />}提取实体</button>}
            {mode === 'full' && (
              <button
                type="button"
                onClick={toggleRight}
                className="text-text-muted hover:text-foreground transition-colors"
                aria-label="Toggle right sidebar"
              >
                {rightCollapsed ? <PanelRightOpen size={16} /> : <PanelRightClose size={16} />}
              </button>
            )}
          </div>
        </div>
      )}

      {/* Main content area: Three-column layout */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left Sidebar */}
        {!hideAllSidebars && !hideLeftOnly && showLeft && (
          <aside className="w-[260px] shrink-0 border-r border-white/10 bg-white/[0.02] backdrop-blur-xl overflow-hidden">
            <LeftSidebar editor={editor} />
          </aside>
        )}

        {/* Editor Content Area / Storyboard View */}
        {aiPreview ? (
          <main className="relative flex-1 min-w-0 overflow-y-auto">
            <AiResultPreview text={aiPreview.text} onAccept={acceptAiPreview} onDiscard={() => setAiPreview(null)} />
          </main>
        ) : viewMode === 'storyboard' ? (
          <main className="relative flex-1 min-w-0 overflow-hidden">
            <StoryboardView editor={editor} onShotClick={handleShotClick} />
          </main>
        ) : (
          <main className={`relative flex-1 min-w-0 overflow-y-auto ${
            viewMode === 'focus' ? 'flex items-start justify-center' : ''
          }`}>
            {/* Offline / local restore banner */}
            {isOffline && (
              <div className="sticky top-0 z-10 flex items-center gap-2 bg-amber-900/30 px-4 py-2 text-xs text-amber-200 border-b border-amber-700/30">
                <WifiOff size={14} />
                <span>{t('status.offlineBanner')}</span>
              </div>
            )}
            {hasNewerLocal && (
              <div className="sticky top-0 z-10 flex items-center justify-between bg-blue-900/30 px-4 py-2 text-xs text-blue-200 border-b border-blue-700/30">
                <div className="flex items-center gap-2">
                  <RotateCcw size={14} />
                  <span>{t('status.localCacheFound')}</span>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={restoreFromLocal}
                    className="rounded bg-blue-700/60 px-2 py-0.5 text-xs hover:bg-blue-700/80 transition-colors"
                  >
                    {t('status.restore')}
                  </button>
                  <button
                    type="button"
                    onClick={dismissLocalRestore}
                    className="text-blue-300/60 hover:text-blue-200 transition-colors"
                  >
                    <X size={14} />
                  </button>
                </div>
              </div>
            )}
            {/* Paste Hint Bar */}
            <PasteHintBar
              visible={showHint}
              analysis={analysis}
              onApply={applyFormatting}
              onDismiss={dismissHint}
            />
            <div
              className={`script-editor script-editor-content mx-auto px-8 py-10 ${
                viewMode === 'focus' ? 'max-w-[860px]' : 'max-w-[720px]'
              }`}
              data-format={currentFormat}
              data-rendering={currentRendering}
            >
              {isReady ? (
                <>
                  <EditorContent
                    editor={editor}
                    className={`prose prose-invert max-w-none focus:outline-none min-h-[60vh] ${
                      isReadOnly ? 'pointer-events-none opacity-90' : ''
                    }`}
                  />
                  {editor && editor.isEmpty && !isReadOnly && (
                    <div className="pointer-events-none absolute inset-x-0 top-24 flex justify-center">
                      <div className="pointer-events-auto rounded-2xl border border-border-subtle bg-glass p-6 text-center shadow-xl">
                        <p className="text-sm font-medium text-foreground">开始创作你的剧本</p>
                        <p className="mt-1 text-xs text-text-muted">选择一个起点，编辑器会立即进入可编辑状态</p>
                        <div className="mt-4 flex flex-wrap justify-center gap-2">
                          <button type="button" onClick={() => editor.commands.insertContent({ type: 'sceneHeading', attrs: { id: crypto.randomUUID(), intExt: 'INT' }, content: [{ type: 'text', text: '新场景 - 日' }] })} className="rounded-full bg-primary px-3 py-1.5 text-xs font-medium text-on-accent">新建空白剧本</button>
                          <button type="button" onClick={() => editor.commands.setContent({ type: 'doc', content: [{ type: 'sceneHeading', attrs: { id: crypto.randomUUID(), intExt: 'INT', location: '室内', timeOfDay: '日' }, content: [{ type: 'text', text: '客厅 - 日' }] }, { type: 'action', content: [{ type: 'text', text: '人物进入场景。' }] }, { type: 'characterCue', content: [{ type: 'text', text: '角色' }] }, { type: 'dialogue', content: [{ type: 'text', text: '这是一个新的故事。' }] }] })} className="rounded-full border border-border-subtle px-3 py-1.5 text-xs text-foreground hover:bg-hover-bg">使用中文短剧模板</button>
                        </div>
                      </div>
                    </div>
                  )}
                </>
              ) : (
                <div className="flex items-center justify-center h-40 text-text-muted text-sm">
                  {t('shell.loading')}
                </div>
              )}
            </div>
          </main>
        )}

        {/* Right Sidebar - Panel */}
        {!hideAllSidebars && (showRight || mode === 'embedded') && (
          <aside className="w-[320px] shrink-0 border-l border-white/10 bg-white/[0.02] backdrop-blur-xl overflow-hidden">
            <RightPanelContainer
              editor={editor}
              projectId={effectiveProjectId}
              onPreview={setAiPreview}
              scope={aiScope}
              onScopeChange={setAiScope}
            />
          </aside>
        )}
      </div>

      {/* Status Bar */}
      {!hideAllSidebars && showToolbar && (
        <div className="flex h-8 shrink-0 items-center gap-4 border-t border-white/10 px-4 text-xs text-text-muted">
          <span>{t('status.wordCount', { count: wordCount })}</span>
          <span className="text-white/20">|</span>
          <span>
            {t('status.sceneCount', { count: derivedScenes.length })}
            {foldingEnabled && (
              <span className="ml-1 text-text-muted/60">
                ({isAllExpanded ? t('status.allExpanded') : t('status.smartFolding')})
              </span>
            )}
          </span>
          <span className="text-white/20">|</span>
          <span>
            {isOffline
              ? t('status.offlineShort')
              : isDirty
                ? t('status.unsavedDot')
                : lastSavedAt
                  ? t('status.savedAt', { time: lastSavedAt.toLocaleTimeString() })
                  : t('status.ready')}
          </span>
          <span className="text-white/20">|</span>
          <ContinuityIndicator report={continuityReport} />
          <span className="ml-auto text-text-muted/60">
            {currentFormat} / {currentRendering}
          </span>
        </div>
      )}

      {/* Shortcut Help Panel */}
      <ShortcutHelpPanel open={showShortcutHelp} onClose={closeShortcutHelp} />
      <ExportDialog open={showExport} onClose={() => setShowExport(false)} projectId={projectId ?? ''} editor={editor} />
    </div>
  );
}
