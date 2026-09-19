import { useEffect, useRef, useCallback } from 'react';
import { Editor } from '@tiptap/react';
import type { Node as PMNode } from '@tiptap/pm/model';
import { scriptEditorApi } from '@/lib/scriptEditorApi';
import { useEditorStore } from '@/store/editorStore';
import { useProjectStore } from '@/store/projectStore';
import { toast } from '@/store/toastStore';
import { scriptTextOf } from '../documentText';

const AUTOSAVE_INTERVAL_MS = 30_000; // 30 seconds

/**
 * 自动保存 Hook
 * - 30s 周期自动保存（仅当 isDirty 时）
 * - Cmd+S / Ctrl+S 手动保存 + 创建快照
 * - 离开编辑器时把还未保存的内容落下（见下面 flush 那段）
 * - beforeunload 事件拦截（离开页面前提醒保存）
 */
export function useAutoSave(editor: Editor | null, projectId: string | null, onMissingProject?: () => void) {
  const { setDirty, setLastSavedAt } = useEditorStore();
  const isSavingRef = useRef(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // flush 需要的最新文档。为什么不能直接读 editor：组件卸载时 `useEditor` 的
  // cleanup 比这里先执行，等到我们跑时 editor 已经 destroy、取不到正文了。
  // 所以随编辑把 doc **引用**记下来 —— ProseMirror 的 Node 是不可变的，
  // `toJSON()` / `textBetween()` 都不依赖 view，离开后照样能用。
  const pendingDocRef = useRef<PMNode | null>(null);
  const projectIdRef = useRef<string | null>(projectId);
  projectIdRef.current = projectId;

  // 核心保存逻辑
  const save = useCallback(
    async (createSnapshot = false) => {
      if (!editor || editor.isDestroyed) return;
      if (!projectId) { onMissingProject?.(); return; }
      if (isSavingRef.current) return;

      const content = editor.getJSON();
      isSavingRef.current = true;

      let text: string;
      try {
        await scriptEditorApi.saveDocument(projectId, content, createSnapshot);
        text = scriptTextOf(editor);
        await scriptEditorApi.updateScriptText(projectId, text);
      } catch (err) {
        console.error('[useAutoSave] Save failed:', err);
        toast.error('剧本保存失败', { body: '内容仍保留在编辑器中，请检查连接后重试。' });
        return;
      } finally {
        isSavingRef.current = false;
      }

      // 落盘已经成功了，下面只是同步本地两份缓存（项目 store 的 original_text 与
      // dirty 标记）。这一段出错**不能**说成「剧本保存失败」—— 服务端已经存好了，
      // 用户再点一次就是重复写，还会以为上一次白存了。
      try {
        useProjectStore.getState().updateProject(projectId, { originalText: text });
        setDirty(false);
        setLastSavedAt(new Date());
      } catch (err) {
        console.error('[useAutoSave] Local state sync after save failed:', err);
      }
    },
    [editor, projectId, onMissingProject, setDirty, setLastSavedAt]
  );

  // 跟着编辑更新缓存的 doc 引用（只存引用，不序列化）。
  useEffect(() => {
    if (!editor) return;
    const cache = () => { pendingDocRef.current = editor.state.doc; };
    cache();
    editor.on('update', cache);
    return () => { editor.off('update', cache); };
  }, [editor]);

  // 离开编辑器 = 离开这一步。分镜生成 / 提取实体 / 「查看脚本」读的都是
  // `script.original_text`，而自动保存要等 30 秒 —— 不在这里落盘，用户改完就走
  // 就会拿到老版本（这就是「接受 AI 修改后生成分镜还是老版本」的另一半根因）。
  useEffect(() => () => {
    if (!useEditorStore.getState().isDirty) return;
    const doc = pendingDocRef.current;
    const pid = projectIdRef.current;
    if (!doc || !pid) return;
    void scriptEditorApi
      .saveDocument(pid, doc.toJSON() as object, false)
      .catch((error) => console.error('[useAutoSave] Flush document failed:', error));
    void scriptEditorApi
      .updateScriptText(pid, doc.textBetween(0, doc.content.size, '\n'))
      .catch((error) => console.error('[useAutoSave] Flush text failed:', error));
  }, []);

  // 30s 周期自动保存
  useEffect(() => {
    intervalRef.current = setInterval(() => {
      if (useEditorStore.getState().isDirty) {
        save(false);
      }
    }, AUTOSAVE_INTERVAL_MS);

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [save]);

  // Cmd+S / Ctrl+S 手动保存（创建快照）
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        save(true); // 手动保存时创建快照
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [save]);

  // beforeunload 拦截
  useEffect(() => {
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      if (useEditorStore.getState().isDirty) {
        e.preventDefault();
        // 尝试在卸载前保存
        if (editor && projectId) {
          const content = editor.getJSON();
          // 使用 sendBeacon 或同步请求不可靠，这里仅做拦截提醒
          navigator.sendBeacon?.(
            `${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:17177'}/projects/${projectId}/document`,
            JSON.stringify({ content, create_snapshot: false })
          );
        }
      }
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [editor, projectId]);

  return { save };
}
