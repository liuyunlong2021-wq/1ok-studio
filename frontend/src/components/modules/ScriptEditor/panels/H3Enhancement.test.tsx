import { useState } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiPreview, AiScope } from './AiPanel';
import { H3_SKILL_ID, type H3Job } from '@/lib/h3PromptEnhancer';

const mocks = vi.hoisted(() => ({ list: vi.fn(), create: vi.fn(), get: vi.fn(), generate: vi.fn() }));
vi.mock('@/lib/scriptEditorApi', () => ({ scriptEditorApi: { listScriptSkills: mocks.list } }));
vi.mock('@/lib/promptEditorApi', () => ({ promptEditorApi: { generate: mocks.generate } }));
vi.mock('@/lib/h3PromptEnhancer', async (original) => ({ ...await original<object>(), h3PromptEnhancer: { create: mocks.create, get: mocks.get } }));
import AiPanel from './AiPanel';

const native = { id: H3_SKILL_ID, name: 'MiniMax H3 提示词增强', content: '内置执行说明', scope: 'system', kind: 'motion', is_builtin: true, executor: 'h3_context_ir', readonly: true };
function editor(text = '舰长留在舰桥') {
  return { getText: () => text, getJSON: () => ({ type: 'doc', text }), state: { selection: { from: 1, to: 1 }, doc: { content: { size: 50 }, textBetween: () => text } }, on: vi.fn(), off: vi.fn() } as any;
}
function Harness({ id = 'draft-1', text, images = [], onPreview }: { id?: string; text?: string; images?: { ref: string; name: string; source: string; description: string }[]; onPreview: (value: AiPreview) => void }) {
  const [scope, setScope] = useState<AiScope | null>(null);
  return <AiPanel purpose="prompt" editor={editor(text)} projectId={id} onPreview={onPreview} scope={scope} onScopeChange={setScope} promptContext={{ style: null, images }} />;
}
let job: H3Job;
async function selectNative() {
  await screen.findByRole('option', { name: 'MiniMax H3 提示词增强 · 内置' });
  fireEvent.change(screen.getByLabelText('Skill'), { target: { value: H3_SKILL_ID } });
}
beforeEach(() => {
  localStorage.clear(); vi.clearAllMocks();
  mocks.list.mockResolvedValue([native]);
  mocks.create.mockImplementation(async (id, input) => {
    job = { job_id: id, response_id: 'resp_ui', status: 'in_progress', text: '', error: '', source_text: input.text, source_context: input.source_context, duration: input.duration, ratio: input.ratio };
    return job;
  });
  mocks.get.mockImplementation(async () => ({ ...job, status: 'completed', text: '增强后的提示词' }));
});
afterEach(cleanup);

describe('native H3 Skill', () => {
  it('calls Context IR once and previews a source snapshot without using the text generator', async () => {
    const onPreview = vi.fn();
    render(<Harness onPreview={onPreview} />);
    await selectNative();
    fireEvent.change(screen.getByLabelText('H3 增强时长'), { target: { value: '8' } });
    fireEvent.change(screen.getByLabelText('H3 增强画幅'), { target: { value: '16:9' } });
    fireEvent.click(screen.getByRole('button', { name: '增强提示词' }));
    fireEvent.click(screen.getByRole('button', { name: /增强/ }));
    await waitFor(() => expect(onPreview).toHaveBeenCalledTimes(1));
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(mocks.generate).not.toHaveBeenCalled();
    expect(mocks.create.mock.calls[0][1]).toMatchObject({ text: '舰长留在舰桥', duration: 8, ratio: '16:9' });
    expect(onPreview.mock.calls[0][0]).toMatchObject({ text: '增强后的提示词', sourceText: '舰长留在舰桥', sourceDocument: JSON.stringify(editor().getJSON()), sourceContext: JSON.stringify({ style: null, images: [] }) });
    act(() => onPreview.mock.calls[0][0].onResolved());
    expect(localStorage.getItem('1okstudio:h3-enhancement:prompt:draft-1')).toBeNull();
  });

  it('disables invalid duration before any create request', async () => {
    render(<Harness onPreview={vi.fn()} />);
    await selectNative();
    fireEvent.change(screen.getByLabelText('H3 增强时长'), { target: { value: '30' } });
    expect(screen.getByRole('button', { name: '增强提示词' })).toBeDisabled();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('accepts an instruction for an empty document', async () => {
    render(<Harness text="" onPreview={vi.fn()} />);
    await selectNative();
    expect(screen.getByRole('button', { name: '增强提示词' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('本次要求'), { target: { value: '雨夜的侦探' } });
    fireEvent.click(screen.getByRole('button', { name: '增强提示词' }));
    await waitFor(() => expect(mocks.create).toHaveBeenCalled());
    expect(mocks.create.mock.calls[0][1]).toMatchObject({ text: '', instruction: '雨夜的侦探' });
    expect(mocks.create.mock.calls[0][1].images).toEqual([]);
  });

  it('binds editor images as ordered first and last frames', async () => {
    render(<Harness onPreview={vi.fn()} images={[{ ref: 'assets/first.png', name: '开场', source: 'upload', description: '' }, { ref: 'assets/last.png', name: '结束', source: 'upload', description: '' }]} />);
    await selectNative();
    fireEvent.change(screen.getByLabelText('H3 图片用途'), { target: { value: 'first_last' } });
    fireEvent.click(screen.getByRole('button', { name: '增强提示词' }));
    await waitFor(() => expect(mocks.create).toHaveBeenCalled());
    expect(mocks.create.mock.calls[0][1].images).toEqual([{ ref: 'assets/first.png', name: '开场', role: 'first_frame' }, { ref: 'assets/last.png', name: '结束', role: 'last_frame' }]);
  });

  it('rejects missing first frame before submitting', async () => {
    render(<Harness onPreview={vi.fn()} />);
    await selectNative();
    fireEvent.change(screen.getByLabelText('H3 图片用途'), { target: { value: 'first_frame' } });
    expect(screen.getByRole('button', { name: '增强提示词' })).toBeDisabled();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('a known local validation rejection releases the request for correction', async () => {
    mocks.create.mockRejectedValue({ response: { status: 400, data: { detail: '请先配置 API Key' } } });
    render(<Harness onPreview={vi.fn()} />);
    await selectNative();
    fireEvent.click(screen.getByRole('button', { name: '增强提示词' }));
    await screen.findByText('请先配置 API Key');
    expect(screen.getByRole('button', { name: '增强提示词' })).toBeEnabled();
    expect(mocks.get).not.toHaveBeenCalled();
    expect(localStorage.getItem('1okstudio:h3-enhancement:prompt:draft-1')).toBeNull();
  });

  it('a lost creation response queries the original request without retrying creation', async () => {
    const create = mocks.create.getMockImplementation()!;
    mocks.create.mockImplementationOnce(async (...args) => { await create(...args); throw new Error('response lost'); });
    const onPreview = vi.fn();
    render(<Harness onPreview={onPreview} />);
    await selectNative();
    fireEvent.click(screen.getByRole('button', { name: '增强提示词' }));
    await screen.findByRole('button', { name: '继续查询' });
    expect(screen.getByRole('button', { name: '增强提示词' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '继续查询' }));
    await waitFor(() => expect(onPreview).toHaveBeenCalled());
    expect(mocks.create).toHaveBeenCalledTimes(1);
  });

  it('resumes a retained result on reopening without creating a second task', async () => {
    const id = '12345678-1234-4234-9234-123456789012';
    localStorage.setItem('1okstudio:h3-enhancement:prompt:draft-1', id);
    job = { job_id: id, response_id: 'resp_saved', status: 'completed', text: '保留结果', error: '', source_text: '旧原文', source_context: JSON.stringify({ documentId: 'draft-1', preview: { range: null, sourceText: '旧原文', sourceDocument: 'old snapshot', sourceContext: '{}' } }), duration: 5, ratio: '9:16' };
    const onPreview = vi.fn();
    render(<Harness onPreview={onPreview} />);
    await waitFor(() => expect(onPreview).toHaveBeenCalled());
    expect(mocks.create).not.toHaveBeenCalled();
    expect(onPreview.mock.calls[0][0].sourceDocument).toBe('old snapshot');
  });

  it('switching documents during polling never delivers to the new document', async () => {
    let complete!: (value: H3Job) => void;
    mocks.get.mockImplementation(() => new Promise<H3Job>((resolve) => { complete = resolve; }));
    const onPreview = vi.fn();
    const view = render(<Harness onPreview={onPreview} />);
    await selectNative();
    fireEvent.click(screen.getByRole('button', { name: '增强提示词' }));
    await waitFor(() => expect(mocks.get).toHaveBeenCalled());
    view.rerender(<Harness id="draft-2" onPreview={onPreview} />);
    await act(async () => complete({ ...job, status: 'completed', text: '旧文档的结果' }));
    expect(onPreview).not.toHaveBeenCalled();
    expect(localStorage.getItem('1okstudio:h3-enhancement:prompt:draft-1')).toBeTruthy();
  });
});
