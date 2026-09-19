import { useState } from 'react';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithIntl } from '@/test-utils/renderWithIntl';

const listScriptSkills = vi.fn();
const standardizeScript = vi.fn();

vi.mock('@/lib/scriptEditorApi', () => ({
  scriptEditorApi: {
    listScriptSkills: (...args: unknown[]) => listScriptSkills(...args),
    standardizeScript: (...args: unknown[]) => standardizeScript(...args),
  },
}));

import AiPanel, { type AiScope } from './AiPanel';

const builtin = {
  id: 'builtin-short',
  name: '中文短剧标准化',
  content: '格式规则',
  scope: 'system',
  is_builtin: true,
  kind: 'script' as const,
};

const SELECTED_TEXT = '选中原文';

/**
 * 假编辑器：能改 selection，也能像 Tiptap 那样派发 selectionUpdate。
 * 作用范围靠这个事件同步 —— 所以测试要能真的触发它，而不是只摆一个 state。
 */
function fakeEditor(initialSelection = { from: 1, to: 1 }) {
  const handlers: Record<string, Array<() => void>> = {};
  const api = {
    state: {
      selection: initialSelection,
      doc: { textBetween: vi.fn(() => SELECTED_TEXT) },
    },
    getText: vi.fn(() => '全文原稿'),
    on: vi.fn((event: string, cb: () => void) => {
      (handlers[event] ||= []).push(cb);
    }),
    off: vi.fn(),
  };
  return {
    editor: api as any,
    /** 模拟用户框选（from === to 就是点了一下、只放下光标）。 */
    select(from: number, to: number) {
      api.state.selection = { from, to };
      for (const cb of handlers.selectionUpdate ?? []) cb();
    },
  };
}

/** AiPanel 现在是受控的（作用范围由父级持有），所以测试也得有个父级。 */
function Harness({ editor, onPreview }: { editor: any; onPreview: (preview: any) => void }) {
  const [scope, setScope] = useState<AiScope | null>(null);
  return (
    <AiPanel
      editor={editor}
      projectId="episode-1"
      onPreview={onPreview}
      scope={scope}
      onScopeChange={setScope}
    />
  );
}

describe('AiPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listScriptSkills.mockResolvedValue([builtin]);
    standardizeScript.mockResolvedValue({ standardized_text: 'AI 新稿', model: 'test' });
  });

  it('默认作用于全文，发送的是整篇', async () => {
    const onPreview = vi.fn();
    renderWithIntl(<Harness editor={fakeEditor().editor} onPreview={onPreview} />);

    await screen.findByRole('option', { name: '中文短剧标准化 · 内置' });
    expect(screen.getByRole('combobox')).toHaveValue('builtin-short');
    expect(screen.getByText(/作用范围：全文/)).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText('输入这次希望 AI 完成的修改要求'), {
      target: { value: '只整理格式' },
    });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));

    await waitFor(() => expect(standardizeScript).toHaveBeenCalledWith(
      'episode-1', '全文原稿', '格式规则', 'builtin-short', '只整理格式',
    ));
    expect(onPreview).toHaveBeenCalledWith({ text: 'AI 新稿', range: null, sourceText: '全文原稿' });
  });

  it('框选之后只改选中的段落，并把范围报给预览', async () => {
    const onPreview = vi.fn();
    const { editor, select } = fakeEditor();
    renderWithIntl(<Harness editor={editor} onPreview={onPreview} />);

    await screen.findByRole('option', { name: '中文短剧标准化 · 内置' });
    select(2, 6);

    // 面板里要看得出「改的是哪一段、多少字」
    expect(await screen.findByText('作用范围：已框选 4 字')).toBeInTheDocument();
    expect(screen.getByText(SELECTED_TEXT)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '发送' }));

    await waitFor(() => expect(standardizeScript).toHaveBeenCalledWith(
      'episode-1', SELECTED_TEXT, '格式规则', 'builtin-short', '',
    ));
    expect(onPreview).toHaveBeenCalledWith({
      text: 'AI 新稿',
      range: { from: 2, to: 6 },
      sourceText: SELECTED_TEXT,
    });
  });

  it('光标移动到别处不会把已框选的范围丢掉', async () => {
    // 回归：原来作用范围读的是「此刻的选区」，光标一动就退回全文 ——
    // 用户明明框过，面板却悄悄改成全文，然后就改错了地方。
    const { editor, select } = fakeEditor();
    renderWithIntl(<Harness editor={editor} onPreview={vi.fn()} />);

    await screen.findByRole('option', { name: '中文短剧标准化 · 内置' });
    select(2, 6);
    expect(await screen.findByText('作用范围：已框选 4 字')).toBeInTheDocument();

    select(9, 9); // 只是点了一下，没有框选

    expect(screen.getByText('作用范围：已框选 4 字')).toBeInTheDocument();
  });

  it('「改为全文」把范围清掉', async () => {
    const { editor, select } = fakeEditor();
    renderWithIntl(<Harness editor={editor} onPreview={vi.fn()} />);

    await screen.findByRole('option', { name: '中文短剧标准化 · 内置' });
    select(2, 6);
    fireEvent.click(await screen.findByRole('button', { name: '改为全文' }));

    expect(await screen.findByText(/作用范围：全文/)).toBeInTheDocument();
  });
});
