import type { Editor } from '@tiptap/react';

/**
 * 剧本编辑器的纯文本导出规则 —— 只在这里实现一次。
 *
 * Tiptap 的 `getText()` **块间默认不加任何分隔符**，整篇会连成一行。而下游
 * （分镜生成、实体提取、AI 修改、保存到 `original_text`）全部靠换行分行，
 * 所以取正文的地方一律走这里，别直接调 `editor.getText()`。
 */
export function normalizeScriptText(text: string): string {
  // Recover only the known legacy damage inside a bracketed time range.
  return text.replace(/([【\[]\d{1,3})\s*\n\s*(\d{2}\s*[-—–]\s*\d{1,3}:\d{2}[】\]])/g, '$1:$2');
}

export function scriptTextOf(editor: Editor): string {
  return normalizeScriptText(editor.getText({ blockSeparator: '\n' }));
}
