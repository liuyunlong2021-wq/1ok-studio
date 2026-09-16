/**
 * AI 作用范围高亮。
 *
 * 这里刻意用**真实的 Tiptap 编辑器**（不是 mock）：整套东西的价值就在于
 * 「正文里真的画出了一段淡紫底」，而这一点只有让 ProseMirror 装上 plugin、
 * 渲染出来才说得清。节点只用 Action —— 它就是 `block / inline*`，不需要
 * 拖进整个剧本 schema。
 */
import { describe, expect, it } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';

import { Action } from './Action';
import { AiScopeHighlight, aiScopeKey, applyAiScope } from './AiScopeHighlight';

function makeEditor() {
    return new Editor({
        element: document.createElement('div'),
        // StarterKit 在这里只为了提供 `doc`（顶层节点）；正文节点用剧本自己的 Action。
        extensions: [StarterKit, Action, AiScopeHighlight],
        content: {
            type: 'doc',
            content: [
                { type: 'action', content: [{ type: 'text', text: '第一段' }] },
                { type: 'action', content: [{ type: 'text', text: '第二段' }] },
            ],
        },
    });
}

/** 借 editor 跑一段，结束一定销毁 —— 不然 happy-dom 里会留下挂着的 view。 */
function withEditor(run: (editor: Editor) => void) {
    const editor = makeEditor();
    try {
        run(editor);
    } finally {
        editor.destroy();
    }
}

const decorationsOf = (editor: Editor) => aiScopeKey.getState(editor.state)?.find() ?? [];

/**
 * 装饰只落在 **view 渲染出来的 DOM** 上：`editor.getHTML()` 是走 schema 序列化的，
 * 不经过 view，所以它永远看不到 decoration。要看「真的画出来了」只能看这里。
 */
const renderedHtml = (editor: Editor) => editor.view.dom.innerHTML;

describe('AI 作用范围高亮', () => {
    it('没设范围时正文里没有任何标记', () => {
        withEditor((editor) => {
            expect(decorationsOf(editor)).toHaveLength(0);
            expect(renderedHtml(editor)).not.toContain('rgba(167,139,250');
        });
    });

    it('设了范围就把那一段在正文里画出来', () => {
        withEditor((editor) => {
            applyAiScope(editor.view, { from: 1, to: 4 });

            const [mark] = decorationsOf(editor);
            expect(mark).toBeDefined();
            expect(mark.from).toBe(1);
            expect(mark.to).toBe(4);
            // 真的渲染成 inline 样式了，而不只是插件 state 里有个数字
            expect(renderedHtml(editor)).toContain('rgba(167,139,250');
        });
    });

    it('传 null 会把标记收掉', () => {
        withEditor((editor) => {
            applyAiScope(editor.view, { from: 1, to: 4 });
            applyAiScope(editor.view, null);

            expect(decorationsOf(editor)).toHaveLength(0);
            expect(renderedHtml(editor)).not.toContain('rgba(167,139,250');
        });
    });

    it('范围越界会被夹到文档里，而不是抛错', () => {
        // 调用方给的 from/to 可能来自上一次编辑之前，夹紧比崩掉强。
        withEditor((editor) => {
            applyAiScope(editor.view, { from: 1, to: 9999 });

            const [mark] = decorationsOf(editor);
            expect(mark.to).toBeLessThanOrEqual(editor.state.doc.content.size);
        });
    });

    it('空范围等于没有范围', () => {
        withEditor((editor) => {
            applyAiScope(editor.view, { from: 3, to: 3 });

            expect(decorationsOf(editor)).toHaveLength(0);
        });
    });

    it('文档被编辑后，标记跟着内容走而不是停在原地', () => {
        // 否则用户改了几个字，高亮就留在别的段落上了 —— 比不画还糟。
        withEditor((editor) => {
            applyAiScope(editor.view, { from: 1, to: 4 });
            editor.commands.insertContentAt(0, { type: 'action', content: [{ type: 'text', text: '新插一段' }] });

            const [mark] = decorationsOf(editor);
            expect(mark.from).toBeGreaterThan(1);
        });
    });
});
