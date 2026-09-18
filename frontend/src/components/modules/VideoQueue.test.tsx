import { fireEvent, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithIntl } from '@/test-utils/renderWithIntl';

const saveMedia = vi.fn();
const revealMedia = vi.fn();
// 回捞用到的两个接口：vi.mock 会被提升到文件顶部，被它引用的变量必须用 vi.hoisted
// 声明，否则工厂跑的时候它们还没初始化。
const resumeVideoTask = vi.hoisted(() => vi.fn());
const getProject = vi.hoisted(() => vi.fn());
const cancelVideoTask = vi.hoisted(() => vi.fn());

vi.mock('@/lib/mediaActions', () => ({
  saveMedia: (...args: unknown[]) => saveMedia(...args),
  revealMedia: (...args: unknown[]) => revealMedia(...args),
}));

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api');
  return {
    ...actual,
    api: { ...actual.api, resumeVideoTask, getProject, cancelVideoTask },
  };
});

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

describe('VideoQueue 回捞（上游任务号还在时）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resumeVideoTask.mockResolvedValue({ id: 'task-1', status: 'processing' });
    getProject.mockResolvedValue({ id: 'project-1', frames: [] });
  });

  it('有上游任务号时给「继续回捞」，而不是只让用户重新生成', async () => {
    renderWithIntl(
      <VideoQueue
        tasks={[{ ...task, status: 'failed', video_url: undefined, error: '下载被拦了一下', provider_task_id: 'task_GATEWAY' }]}
        onRemix={vi.fn()}
      />,
    );

    const button = screen.getByRole('button', { name: '继续回捞' });
    fireEvent.click(button);

    await waitFor(() => expect(resumeVideoTask).toHaveBeenCalledWith('project-1', 'task-1'));
    // 重新生成要单独点，且写明会再扣一次费 —— 不能让人顺手点到
    expect(screen.getByRole('button', { name: '改成重新生成（会再扣一次费）' })).toBeTruthy();
  });

  it('没有上游任务号时只给原来的重试', () => {
    renderWithIntl(
      <VideoQueue tasks={[{ ...task, status: 'failed', video_url: undefined }]} onRemix={vi.fn()} />,
    );

    expect(screen.queryByRole('button', { name: '继续回捞' })).toBeNull();
    expect(screen.getByRole('button', { name: '重试任务' })).toBeTruthy();
  });
});

// 失败任务要能跟后端日志对上时间，跑着的任务要能停 —— 这两条是「后台成功但界面说
// 失败」那次的直接补救。
describe('VideoQueue 时间与取消', () => {
  const started = Math.floor(Date.now() / 1000) - 372; // 已跑 6 分 12 秒

  beforeEach(() => {
    vi.clearAllMocks();
    cancelVideoTask.mockResolvedValue({ id: 'task-1', status: 'failed' });
    getProject.mockResolvedValue({ id: 'project-1', frames: [] });
  });

  it('生成中的任务显示提交时间与已等时长', () => {
    renderWithIntl(
      <VideoQueue
        tasks={[{ ...task, status: 'processing', video_url: undefined, created_at: started, started_at: started }]}
        onRemix={vi.fn()}
      />,
    );

    expect(screen.getByText(/提交/)).toBeTruthy();
    expect(screen.getByText(/已等 6 分 12 秒/)).toBeTruthy();
  });

  it('取消按钮只在跑着的时候出现', () => {
    renderWithIntl(
      <VideoQueue tasks={[{ ...task, status: 'processing', video_url: undefined, started_at: started }]} onRemix={vi.fn()} />,
    );
    expect(screen.getByRole('button', { name: '取消' })).toBeTruthy();
  });

  it('已完成的任务不给取消按钮（别让人误点掉成品）', () => {
    renderWithIntl(
      <VideoQueue tasks={[{ ...task, finished_at: started + 60, started_at: started }]} onRemix={vi.fn()} />,
    );

    expect(screen.queryByRole('button', { name: '取消' })).toBeNull();
    expect(screen.getByText(/完成 · 用时 1 分 0 秒/)).toBeTruthy();
  });

  it('点取消会通知后端并刷新项目', async () => {
    renderWithIntl(
      <VideoQueue tasks={[{ ...task, status: 'processing', video_url: undefined, started_at: started }]} onRemix={vi.fn()} />,
    );

    fireEvent.click(screen.getByRole('button', { name: '取消' }));

    await waitFor(() => expect(cancelVideoTask).toHaveBeenCalledWith('project-1', 'task-1'));
    await waitFor(() => expect(getProject).toHaveBeenCalledWith('project-1'));
  });

  it('失败的任务带着失败时间与用时，方便去后端日志里对', () => {
    renderWithIntl(
      <VideoQueue
        tasks={[{
          ...task, status: 'failed', video_url: undefined,
          error: '上游 502', started_at: started, finished_at: started + 120,
        }]}
        onRemix={vi.fn()}
      />,
    );

    expect(screen.getByText(/失败 · 用时 2 分 0 秒/)).toBeTruthy();
    expect(screen.getByText('上游 502')).toBeTruthy();
  });
});
