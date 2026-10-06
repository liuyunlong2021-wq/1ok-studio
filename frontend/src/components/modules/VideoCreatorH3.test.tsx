import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithIntl } from '@/test-utils/renderWithIntl';
import type { H3Job } from '@/lib/h3PromptEnhancer';
import type { VideoParams } from '@/store/projectStore';

const mocks = vi.hoisted(() => ({ list: vi.fn(), assemble: vi.fn(), create: vi.fn(), get: vi.fn(), state: { currentProject: null as any, updateProject: vi.fn() } }));
vi.mock('@/store/projectStore', () => ({ useProjectStore: (selector: (state: typeof mocks.state) => unknown) => selector(mocks.state) }));
vi.mock('@/lib/scriptEditorApi', () => ({ scriptEditorApi: { listScriptSkills: mocks.list } }));
vi.mock('@/lib/api', () => ({ API_URL: 'http://localhost', api: { assembleMotionPrompt: mocks.assemble } }));
vi.mock('@/lib/modelCatalog', async (original) => ({ ...await original<object>(), I2V_MODE_AVAILABLE: false }));
vi.mock('@/lib/h3PromptEnhancer', async (original) => ({ ...await original<object>(), h3PromptEnhancer: { create: mocks.create, get: mocks.get } }));
import VideoCreator from './VideoCreator';

let job: H3Job;
const params = { model: 'jiucaihezi/minimax-h3-ref2v', duration: 5, generationMode: 'r2v', cameraMovement: 'none', subjectMotion: 'still', resolution: '720p', batchSize: 1, negativePrompt: '' } as VideoParams;
function renderMotion() {
  return renderWithIntl(<VideoCreator params={params} onParamsChange={vi.fn()} onShotTimingChange={vi.fn()} onTaskCreated={vi.fn()} remixData={null} onRemixClear={vi.fn()} />);
}
async function choose() {
  await screen.findByRole('option', { name: 'MiniMax H3 提示词增强 · 内置' });
  fireEvent.click(screen.getByText('舰长站在舰桥'));
  fireEvent.change(screen.getByLabelText('提示词 Skill'), { target: { value: 'builtin-h3-context-ir' } });
}
beforeEach(() => {
  localStorage.clear(); vi.clearAllMocks();
  mocks.state.currentProject = { id: 'episode-1', frames: [{ id: 'shot-1', duration: 5, action_description: '舰长站在舰桥' }], characters: [], scenes: [], props: [], model_settings: { storyboard_aspect_ratio: '16:9' } };
  mocks.list.mockResolvedValue([{ id: 'builtin-h3-context-ir', hidden: false }]);
  mocks.assemble.mockResolvedValue({ prompt: '镜头1：舰长站在舰桥；时长5秒' });
  mocks.create.mockImplementation(async (id, input) => {
    job = { job_id: id, response_id: 'resp_motion', status: 'in_progress', error: '', text: '', source_text: input.text, source_context: input.source_context, duration: input.duration, ratio: input.ratio };
    return job;
  });
  mocks.get.mockImplementation(async () => ({ ...job, status: 'completed', text: '增强后的动作提示词' }));
});
afterEach(cleanup);

describe('Motion uses the shared H3 Skill', () => {
  it('assembles an empty draft locally, previews, adopts and restores the original', async () => {
    renderMotion(); await choose();
    fireEvent.click(screen.getByRole('button', { name: '增强提示词' }));
    await screen.findByText('H3 增强结果预览');
    expect(mocks.assemble).toHaveBeenCalledTimes(1);
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(mocks.create.mock.calls[0][1]).toMatchObject({ text: '镜头1：舰长站在舰桥；时长5秒', duration: 5, ratio: '16:9', images: [] });
    expect(screen.getByRole('textbox')).toHaveValue('');
    fireEvent.click(screen.getByRole('button', { name: '采用增强结果' }));
    await waitFor(() => expect(screen.getByRole('textbox')).toHaveValue('增强后的动作提示词'));
    fireEvent.click(screen.getByRole('button', { name: '恢复增强前提示词' }));
    await waitFor(() => expect(screen.getByRole('textbox')).toHaveValue(''));
  });

  it('changing the draft while waiting blocks adoption without losing the result', async () => {
    let complete!: (value: H3Job) => void;
    mocks.get.mockImplementation(() => new Promise<H3Job>((resolve) => { complete = resolve; }));
    renderMotion(); await choose();
    fireEvent.click(screen.getByRole('button', { name: '增强提示词' }));
    await waitFor(() => expect(mocks.get).toHaveBeenCalled());
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '等待期间修改的原文' } });
    await act(async () => complete({ ...job, status: 'completed', text: '旧输入的增强结果' }));
    expect(screen.getByRole('button', { name: '采用增强结果' })).toBeDisabled();
    expect(screen.getByRole('textbox')).toHaveValue('等待期间修改的原文');
    expect(screen.getByText('旧输入的增强结果')).toBeInTheDocument();
  });

  it('rejects a 20-second selection before submitting or assembling', async () => {
    mocks.state.currentProject.frames[0].duration = 20;
    renderMotion(); await choose();
    expect(screen.getByRole('button', { name: '增强提示词' })).toBeDisabled();
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.assemble).not.toHaveBeenCalled();
  });
});
