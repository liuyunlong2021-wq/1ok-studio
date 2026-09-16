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

import AiPanel from './AiPanel';

const builtin = {
  id: 'builtin-short',
  name: '中文短剧标准化',
  content: '格式规则',
  scope: 'system',
  is_builtin: true,
  kind: 'script' as const,
};

function editor(selection = { from: 1, to: 1 }) {
  return {
    state: {
      selection,
      doc: { textBetween: vi.fn(() => '选中原文') },
    },
    getText: vi.fn(() => '全文原稿'),
    on: vi.fn(),
    off: vi.fn(),
  } as any;
}

describe('AiPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listScriptSkills.mockResolvedValue([builtin]);
    standardizeScript.mockResolvedValue({ standardized_text: 'AI 新稿', model: 'test' });
  });

  it('loads the built-in skill and sends a full-document request', async () => {
    const onPreview = vi.fn();
    renderWithIntl(<AiPanel editor={editor()} projectId="episode-1" onPreview={onPreview} />);

    await screen.findByRole('option', { name: '中文短剧标准化 · 内置' });
    expect(screen.getByRole('combobox')).toHaveValue('builtin-short');
    expect(screen.getByText('作用范围：全文')).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText('输入这次希望 AI 完成的修改要求'), {
      target: { value: '只整理格式' },
    });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));

    await waitFor(() => expect(standardizeScript).toHaveBeenCalledWith(
      'episode-1', '全文原稿', '格式规则', 'builtin-short', '只整理格式',
    ));
    expect(onPreview).toHaveBeenCalledWith({ text: 'AI 新稿', range: null });
  });

  it('sends only the current selection and reports that scope', async () => {
    const onPreview = vi.fn();
    renderWithIntl(<AiPanel editor={editor({ from: 2, to: 6 })} projectId="episode-1" onPreview={onPreview} />);

    await screen.findByRole('option', { name: '中文短剧标准化 · 内置' });
    expect(screen.getByText('作用范围：当前选区')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '发送' }));

    await waitFor(() => expect(standardizeScript).toHaveBeenCalledWith(
      'episode-1', '选中原文', '格式规则', 'builtin-short', '',
    ));
    expect(onPreview).toHaveBeenCalledWith({ text: 'AI 新稿', range: { from: 2, to: 6 } });
  });
});
