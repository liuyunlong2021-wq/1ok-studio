/**
 * 视频结果的卡片预览。
 *
 * 以前 CompletedCard 对视频只画一个静态 Video 图标占位（出图走 <img>、出视频走图标），
 * 于是列表里凡是视频都是一片白。这里守住两条：
 * 1. 有 media_path 的视频必须渲染真实的 <video>；
 * 2. 拿到 metadata 后要 seek 到**非零**位置 —— 部分内核（WKWebView / WebView2）
 *    只靠 preload="metadata" 不会重绘首帧。
 */
import { fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithIntl } from '@/test-utils/renderWithIntl';

vi.mock('@/lib/mediaActions', () => ({
  saveMedia: vi.fn(),
  revealMedia: vi.fn(),
}));

import ResultCard from './ResultCard';
import type { PlaygroundGeneration } from './usePlaygroundStore';

function makeGeneration(mediaType: 'video' | 'image'): PlaygroundGeneration {
  return {
    id: 'gen-1',
    mode: mediaType === 'video' ? 'i2v' : 't2i',
    model_id: 'minimax_h3_i2v_04',
    prompt: '一只金甲妖猴停在半空',
    input_media: [],
    parameters: { resolution: '768p' },
    batch_size: 1,
    outputs: [
      {
        id: 'out-1',
        media_path:
          mediaType === 'video' ? 'playground/videos/i2v_1.mp4' : 'playground/images/t2i_1.png',
        media_type: mediaType,
        saved_to_library: false,
      },
    ],
    status: 'completed',
    created_at: '2026-09-19T10:00:00',
  };
}

/** happy-dom 的 HTMLMediaElement 没实现 currentTime 的写行为，自己造一个可写的。 */
function makeCurrentTimeWritable(video: HTMLVideoElement) {
  Object.defineProperty(video, 'currentTime', { value: 0, writable: true, configurable: true });
}

describe('ResultCard 视频预览', () => {
  it('视频结果渲染真实的 <video>，不是只有图标占位', () => {
    const { container } = renderWithIntl(<ResultCard generation={makeGeneration('video')} />);

    const video = container.querySelector('video');
    expect(video).not.toBeNull();
    expect(video?.getAttribute('preload')).toBe('metadata');
    // 首帧预览是「看一眼内容」，不该自动播放出声
    expect(video?.hasAttribute('muted')).toBe(true);
  });

  it('拿到 metadata 后 seek 到非零位置（否则部分内核不画首帧）', () => {
    const { container } = renderWithIntl(<ResultCard generation={makeGeneration('video')} />);
    const video = container.querySelector('video') as HTMLVideoElement;
    makeCurrentTimeWritable(video);

    fireEvent.loadedMetadata(video);

    expect(video.currentTime).toBeGreaterThan(0);
  });

  it('图片结果仍然走 <img>，不受影响', () => {
    const { container } = renderWithIntl(<ResultCard generation={makeGeneration('image')} />);

    expect(container.querySelector('img')).not.toBeNull();
    expect(container.querySelector('video')).toBeNull();
  });
});
