'use client';

import type { Editor } from '@tiptap/react';
import type { AiPreview } from '../panels/AiPanel';
import { analyzeText, buildFormattedContent } from '../hooks/usePasteHandler';

/**
 * 纯文本 → 编辑器节点。
 *
 * 走和手动粘贴同一套启发式规则：以前的实现在这里把每行都当 action，
 * 结果 AI 标准化的剧本进来后场次标题、角色名、对白全部丢结构（左侧场景
 * 导航和角色面板因此永远是空的）。改格式不许再各写一套解析。
 */
export function textToEditorDocument(text: string) {
  const normalized = text.replace(/\r\n?/g, '\n');
  const nodes = buildFormattedContent(normalized, analyzeText(normalized).suggestions);
  // 空文本也要是个合法 doc，否则 setContent 会清不干净。
  return { type: 'doc', content: nodes.length ? nodes : [{ type: 'action', content: [] }] };
}

export function applyAiPreview(editor: Editor, preview: AiPreview) {
  const document = textToEditorDocument(preview.text);
  if (preview.range) editor.commands.insertContentAt(preview.range, document.content);
  else editor.commands.setContent(document);
  editor.commands.focus();
}

export default function AiResultPreview({ text, onAccept, onDiscard }: { text: string; onAccept: () => void; onDiscard: () => void }) {
  return (
    <div className="mx-auto max-w-[720px] px-8 py-10">
      <div className="mb-4 flex items-center justify-between rounded-xl border border-primary/30 bg-primary/10 px-4 py-3">
        <div><p className="text-sm font-medium text-foreground">AI 修改预览</p><p className="text-xs text-text-muted">接受前不会写入剧本。</p></div>
        <div className="flex gap-2"><button type="button" onClick={onDiscard} className="rounded-lg border border-border-subtle px-3 py-1.5 text-xs text-foreground">放弃</button><button type="button" onClick={onAccept} className="rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-on-accent">接受修改</button></div>
      </div>
      <pre className="min-h-[60vh] whitespace-pre-wrap rounded-xl border border-border-subtle bg-surface p-6 font-sans text-sm leading-7 text-foreground">{text}</pre>
    </div>
  );
}
