/**
 * AI 作用范围高亮 —— 把「这次 AI 只改这一段」在正文里画出来。
 *
 * 为什么需要它：作用范围原来只是右侧面板里一行「作用范围：当前选区」的字。
 * 用户在正文里看不出到底框了哪儿，于是「我只想改这一句」常常变成改了别的段落，
 * 或者本该只改一处却动了全文 —— 而且两种错法都不会有任何提示。
 *
 * 用法（`null` = 没有范围，回到全文）：
 *   applyAiScope(editor.view, { from: 12, to: 48 });
 *   applyAiScope(editor.view, null);
 */
import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import type { EditorState } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

export interface AiScopeRange {
    from: number;
    to: number;
}

export const aiScopeKey = new PluginKey<DecorationSet>('aiScopeHighlight');

/** 淡紫底 + 左侧一道竖线：看得见，又不至于把正文盖住。 */
const SCOPE_STYLE =
    'background: rgba(167,139,250,0.16); box-shadow: inset 2px 0 0 0 rgba(167,139,250,0.75);';

export function applyAiScope(view: EditorView, range: AiScopeRange | null): void {
    if (!range) {
        view.dispatch(view.state.tr.setMeta(aiScopeKey, null));
        return;
    }
    // 夹到文档范围内：调用方给的 range 可能来自上一次编辑之前。
    const max = view.state.doc.content.size;
    const from = Math.max(0, Math.min(range.from, max));
    const to = Math.max(from, Math.min(range.to, max));
    if (from === to) {
        view.dispatch(view.state.tr.setMeta(aiScopeKey, null));
        return;
    }
    view.dispatch(view.state.tr.setMeta(aiScopeKey, { from, to }));
}

export const AiScopeHighlight = Extension.create({
    name: 'aiScopeHighlight',

    addProseMirrorPlugins() {
        return [
            new Plugin<DecorationSet>({
                key: aiScopeKey,
                state: {
                    init: () => DecorationSet.empty,
                    apply(tr, previous, _oldState, newState) {
                        const next = tr.getMeta(aiScopeKey) as AiScopeRange | null | undefined;
                        if (next !== undefined) {
                            if (!next) return DecorationSet.empty;
                            return DecorationSet.create(newState.doc, [
                                Decoration.inline(next.from, next.to, { style: SCOPE_STYLE }),
                            ]);
                        }
                        // 文档被编辑过：把旧范围跟着映射，别停在已经变味的段落上。
                        return previous.map(tr.mapping, tr.doc);
                    },
                },
                props: {
                    decorations(state: EditorState) {
                        return aiScopeKey.getState(state) ?? DecorationSet.empty;
                    },
                },
            }),
        ];
    },
});
