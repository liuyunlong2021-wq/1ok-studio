import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import AiResultPreview, { applyAiPreview, textToEditorDocument } from './AiResultPreview';

describe('AiResultPreview', () => {
  it('shows the generated result in the editor area and offers accept or discard', () => {
    const onAccept = vi.fn();
    const onDiscard = vi.fn();
    render(<AiResultPreview text="AI 生成的新剧本" onAccept={onAccept} onDiscard={onDiscard} />);

    expect(screen.getByText('AI 生成的新剧本')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '接受修改' }));
    expect(onAccept).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: '放弃' }));
    expect(onDiscard).toHaveBeenCalledOnce();
  });

  it('applies a full result or replaces only the captured selection', () => {
    const editor = {
      commands: {
        setContent: vi.fn(),
        insertContentAt: vi.fn(),
        focus: vi.fn(),
      },
    } as any;

    applyAiPreview(editor, { text: '全文新稿', range: null });
    expect(editor.commands.setContent).toHaveBeenCalledOnce();

    applyAiPreview(editor, { text: '局部新稿', range: { from: 2, to: 6 } });
    expect(editor.commands.insertContentAt).toHaveBeenCalledWith(
      { from: 2, to: 6 },
      expect.any(Array),
    );
    expect(editor.commands.focus).toHaveBeenCalledTimes(2);
  });

  it('结构化落地：场次标题、△ 行、角色名对白各自成为节点', () => {
    const doc = textToEditorDocument(
      [
        '场1-1 别墅客厅 - 日',
        '1-2 天台 - 夜',
        '△ 雨点砸在落地窗上。',
        '叶墨（冷笑）：你来晚了。',
        '苏晴：合同我带来了。',
        '△ [SFX] 玻璃碎裂声。',
      ].join('\n'),
    );

    expect(doc.content.map((node) => node.type)).toEqual([
      'sceneHeading',
      'sceneHeading',
      'action',
      'characterCue',
      'dialogue',
      'characterCue',
      'dialogue',
      'action',
    ]);
    // 场次标题原样保留，`useDerivation` 靠它的文本解析地点和时间
    expect(doc.content[0]).toMatchObject({
      content: [{ type: 'text', text: '场1-1 别墅客厅 - 日' }],
    });
  });
});
