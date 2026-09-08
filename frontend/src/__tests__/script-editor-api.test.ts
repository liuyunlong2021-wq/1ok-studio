import { beforeEach, describe, expect, it, vi } from 'vitest';

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
