import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import AiResultPreview, { applyAiPreview } from './AiResultPreview';

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
});
