/**
 * 创作台详情页（DetailPanel）的截帧入口：
 * - 视频结果上出现「截帧」，截出的帧上传后**追加**进参考图（不覆盖其它素材）；
 * - 图片结果不显示该按钮；
 * - 截帧浮层打开时 Esc 只关浮层、不关详情。
 *
 * 浮层本体（video/canvas 取帧）不在单测范围：替换成两个按钮，直接产出 File。
 */
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithIntl } from '@/test-utils/renderWithIntl';

const uploadMedia = vi.hoisted(() => vi.fn());

vi.mock('@/lib/mediaActions', () => ({
  saveMedia: vi.fn(),
  revealMedia: vi.fn(),
}));

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api');
  return {
    ...actual,
    playgroundApi: { ...actual.playgroundApi, uploadMedia },
  };
});

vi.mock('../FrameExtractOverlay', () => ({
  default: ({
    onExtract,
    onClose,
  }: {
    onExtract: (file: File, name: string) => void;
    onClose: () => void;
  }) => (
    <div>
      <button
        onClick={() =>
          onExtract(new File(['x'], 'frame.png', { type: 'image/png' }), 'f @ 00:01.0')
        }
      >
        mock-extract
      </button>
      <button onClick={onClose}>mock-close</button>
    </div>
  ),
}));

import DetailPanel from './DetailPanel';
import { usePlaygroundStore, type PlaygroundGeneration } from './usePlaygroundStore';

function makeGeneration(overrides: Partial<PlaygroundGeneration> = {}): PlaygroundGeneration {
  return {
    id: '952e5068-aaaa-bbbb-cccc-000000000000',
    mode: 'r2v',
    model_id: '海seedance2.5',
    prompt: 'test',
    input_media: [],
    parameters: { resolution: '720p' },
    batch_size: 1,
    outputs: [
      {
        id: 'out-1',
        media_path: 'playground/videos/r2v_1.mp4',
        media_type: 'video',
        saved_to_library: false,
      },
    ],
    status: 'completed',
    created_at: '2026-09-18T10:00:00',
    ...overrides,
  };
}

describe('DetailPanel 截帧', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    uploadMedia.mockResolvedValue({ path: 'playground/uploads/frame_1.png' });
    usePlaygroundStore.setState({ history: [], inputMedia: [], mode: 'r2v' });
  });

  it('视频结果可以截帧：上传后追加进参考图，不动已有素材', async () => {
    const generation = makeGeneration();
    usePlaygroundStore.setState({
      history: [generation],
      inputMedia: ['playground/uploads/existing.png'],
    });

    renderWithIntl(
      <DetailPanel
        generation={generation}
        allGenerations={[generation]}
        onClose={vi.fn()}
        onNavigate={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: '截帧' }));
    fireEvent.click(screen.getByText('mock-extract'));

    await waitFor(() => expect(uploadMedia).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(usePlaygroundStore.getState().inputMedia).toEqual([
        'playground/uploads/existing.png',
        'playground/uploads/frame_1.png',
      ])
    );
  });

  it('图片结果不显示截帧按钮', () => {
    const generation = makeGeneration({
      mode: 't2i',
      outputs: [
        {
          id: 'out-1',
          media_path: 'playground/images/x.png',
          media_type: 'image',
          saved_to_library: false,
        },
      ],
    });
    usePlaygroundStore.setState({ history: [generation] });

    renderWithIntl(
      <DetailPanel
        generation={generation}
        allGenerations={[generation]}
        onClose={vi.fn()}
        onNavigate={vi.fn()}
      />
    );

    expect(screen.queryByRole('button', { name: '截帧' })).toBeNull();
  });

  it('截帧浮层开着时 Esc 只关浮层，不关详情', () => {
    const onClose = vi.fn();
    const generation = makeGeneration();
    usePlaygroundStore.setState({ history: [generation] });

    renderWithIntl(
      <DetailPanel
        generation={generation}
        allGenerations={[generation]}
        onClose={onClose}
        onNavigate={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: '截帧' }));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText('mock-close'));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
