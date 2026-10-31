import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('axios', () => ({
  default: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
  },
}));

import axios from 'axios';
import { API_URL } from '@/lib/api';
import { scriptEditorApi } from '@/lib/scriptEditorApi';

describe('script editor persistence API', () => {
  beforeEach(() => vi.clearAllMocks());

  it('saves and reloads the document through the shared backend URL', async () => {
    const document = { type: 'doc', content: [{ type: 'action' }] };
    vi.mocked(axios.post).mockResolvedValue({ data: { status: 'ok' } });
    vi.mocked(axios.get).mockResolvedValue({ data: document });

    await scriptEditorApi.saveDocument('episode-1', document);
    await expect(scriptEditorApi.loadDocument('episode-1')).resolves.toEqual(document);

    expect(axios.post).toHaveBeenCalledWith(`${API_URL}/projects/episode-1/document`, {
      content: document,
      create_snapshot: false,
    });
    expect(axios.get).toHaveBeenCalledWith(`${API_URL}/projects/episode-1/document`);
  });
});

describe('standardizeScript background job', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it('posts, polls until done and returns the old response shape', async () => {
    vi.mocked(axios.post).mockResolvedValue({ data: { job_id: 'textjob_1', status: 'queued' } });
    vi.mocked(axios.get)
      .mockResolvedValueOnce({ data: { status: 'running' } })
      .mockResolvedValueOnce({ data: { status: 'done', result: '新稿', model: 'claude-sonnet-5-5' } });

    const pending = scriptEditorApi.standardizeScript('p1', '原文', '', 'skill-1', '润色');
    await vi.advanceTimersByTimeAsync(10000);

    await expect(pending).resolves.toEqual({ standardized_text: '新稿', model: 'claude-sonnet-5-5' });
    expect(axios.get).toHaveBeenCalledWith(`${API_URL}/projects/p1/standardize_script/textjob_1`);
  });

  it('surfaces the backend failure reason instead of hanging', async () => {
    vi.mocked(axios.post).mockResolvedValue({ data: { job_id: 'textjob_2' } });
    vi.mocked(axios.get).mockResolvedValue({ data: { status: 'failed', error: '标准化失败: 网关超时（HTTP 524）' } });

    const pending = scriptEditorApi.standardizeScript('p1', '原文', '', undefined, '润色');
    const assertion = expect(pending).rejects.toThrow('524');
    await vi.advanceTimersByTimeAsync(5000);
    await assertion;
  });

  it('tolerates a single failed poll', async () => {
    vi.mocked(axios.post).mockResolvedValue({ data: { job_id: 'textjob_3' } });
    vi.mocked(axios.get)
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce({ data: { status: 'done', result: 'ok', model: '' } });
    const ok = scriptEditorApi.standardizeScript('p1', 'a', '', undefined, 'x');
    await vi.advanceTimersByTimeAsync(10000);
    await expect(ok).resolves.toMatchObject({ standardized_text: 'ok' });
  });

  it('gives up after three consecutive failed polls', async () => {
    vi.mocked(axios.post).mockResolvedValue({ data: { job_id: 'textjob_4' } });
    vi.mocked(axios.get).mockRejectedValue(new Error('network'));
    const bad = scriptEditorApi.standardizeScript('p1', 'a', '', undefined, 'x');
    const assertion = expect(bad).rejects.toThrow('network');
    await vi.advanceTimersByTimeAsync(15000);
    await assertion;
  });
});
