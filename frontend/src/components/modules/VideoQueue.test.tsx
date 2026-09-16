import { fireEvent, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithIntl } from '@/test-utils/renderWithIntl';

const saveMedia = vi.fn();
const revealMedia = vi.fn();

vi.mock('@/lib/mediaActions', () => ({
  saveMedia: (...args: unknown[]) => saveMedia(...args),
  revealMedia: (...args: unknown[]) => revealMedia(...args),
}));

vi.mock('framer-motion', () => ({
  motion: { div: ({ children, className }: { children?: ReactNode; className?: string }) => <div className={className}>{children}</div> },
  AnimatePresence: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));

import VideoQueue from './VideoQueue';

const task = {
  id: 'task-1',
  project_id: 'project-1',
  image_url: 'assets/input.png',
  prompt: '人物向前走',
  status: 'completed' as const,
  video_url: 'video/test.mp4',
  duration: 5,
  resolution: '720p',
  generate_audio: false,
  prompt_extend: true,
  created_at: 1,
};

describe('VideoQueue media actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    saveMedia.mockResolvedValue('/tmp/test.mp4');
    revealMedia.mockResolvedValue(true);
  });

  it('downloads a completed video through the shared media saver', async () => {
    renderWithIntl(<VideoQueue tasks={[task]} onRemix={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '下载视频' }));

    await waitFor(() => expect(saveMedia).toHaveBeenCalledWith(
      'video/test.mp4',
      expect.stringContaining('/files/video/test.mp4'),
    ));
  });

  it('reveals the video and falls back to opening it in a browser tab', async () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    revealMedia.mockResolvedValue(false);
    renderWithIntl(<VideoQueue tasks={[task]} onRemix={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '打开视频文件' }));

    await waitFor(() => expect(revealMedia).toHaveBeenCalledWith('video/test.mp4'));
    expect(open).toHaveBeenCalledWith(expect.stringContaining('/files/video/test.mp4'), '_blank', 'noopener,noreferrer');
    open.mockRestore();
  });
});
