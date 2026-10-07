/**
 * 「用作参考图」的加入规则（useResultAsReference）：
 * - 当前模式收得下这类素材 → **追加到末尾**（已有的参考图不动，新的排后面）；
 * - **单参考/多参考由模型声明的参考图上限决定**（`getMediaInputConfig`）：
 *   上限 ≤ 1 或未知 → 单参考，替换唯一一张；上限 > 1 → 多参考，追加。
 *   i2v/v2v 在 MODE_CONFIG 里恒为单参考，模型上限不覆盖它们；
 *   i2i 跟随上限 —— 默认出图模型（jc-qwen-image-2.1）声明 10 张，所以 i2i 现在是多参考。
 * - 收不下 / 显式 targetMode → 切到承接模式并单独放入；
 * - 满了或重复 → 不动（返回 'full' / 'duplicate'，绝不静默顶掉已有参考图）。
 *
 * 背景：之前无条件整表替换，把截帧加进去的参考图顶掉了。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { usePlaygroundStore } from './usePlaygroundStore';

const call = (...args: Parameters<ReturnType<typeof usePlaygroundStore.getState>['useResultAsReference']>) =>
  usePlaygroundStore.getState().useResultAsReference(...args);

describe('useResultAsReference 加入规则', () => {
  beforeEach(() => {
    usePlaygroundStore.setState({ mode: 'r2v', inputMedia: [], modelPreferences: {} });
  });

  it('多参考模式：追加到末尾，已有的保持在前', () => {
    usePlaygroundStore.setState({ inputMedia: ['playground/uploads/frame.png'] });

    const result = call('playground/uploads/new.png', 'image');

    expect(result).toBe('appended');
    expect(usePlaygroundStore.getState().inputMedia).toEqual([
      'playground/uploads/frame.png',
      'playground/uploads/new.png',
    ]);
    // 不切模式
    expect(usePlaygroundStore.getState().mode).toBe('r2v');
  });

  it('多参考模式满员：拒绝而不是顶掉已有', () => {
    // 显式钉一个「声明 9 张」的模型：这条测的是「满了要拒绝」的规则，
    // 不能跟着默认模型的参考图上限漂（默认出图模型声明的是 10 张）。
    usePlaygroundStore.setState({
      modelId: 'rh_minimax_h3_ref_9',
      inputMedia: Array.from({ length: 9 }, (_, i) => `p/${i}.png`),
    });

    const result = call('p/new.png', 'image');

    expect(result).toBe('full');
    expect(usePlaygroundStore.getState().inputMedia).toHaveLength(9);
    expect(usePlaygroundStore.getState().inputMedia).not.toContain('p/new.png');
  });

  it('单参考模式（i2v）：替换唯一一张', () => {
    usePlaygroundStore.setState({ mode: 'i2v', inputMedia: ['old.png'] });

    const result = call('new.png', 'image');

    expect(result).toBe('replaced');
    expect(usePlaygroundStore.getState().inputMedia).toEqual(['new.png']);
  });

  it('i2i 跟随模型声明的上限：多图模型上是追加，不是替换', () => {
    usePlaygroundStore.setState({ mode: 'i2i', modelId: 'jc-qwen-image-2.1', inputMedia: ['old.png'] });

    expect(call('new.png', 'image')).toBe('appended');
    expect(usePlaygroundStore.getState().inputMedia).toEqual(['old.png', 'new.png']);
  });

  it('类型不兼容：切到承接模式并单独放入（video→v2v）', () => {
    usePlaygroundStore.setState({ mode: 'i2i', inputMedia: ['old.png'] });

    const result = call('clip.mp4', 'video');

    expect(result).toBe('switched');
    expect(usePlaygroundStore.getState().mode).toBe('v2v');
    expect(usePlaygroundStore.getState().inputMedia).toEqual(['clip.mp4']);
  });

  it('显式 targetMode：按目标模式走（生成视频 → i2v 首帧）', () => {
    usePlaygroundStore.setState({ mode: 'r2v', inputMedia: ['a.png', 'b.png'] });

    const result = call('firstframe.png', 'image', 'i2v');

    expect(result).toBe('switched');
    expect(usePlaygroundStore.getState().mode).toBe('i2v');
    expect(usePlaygroundStore.getState().inputMedia).toEqual(['firstframe.png']);
  });

  it('已在列表里：不动、不重复', () => {
    usePlaygroundStore.setState({ inputMedia: ['same.png'] });

    const result = call('same.png', 'image');

    expect(result).toBe('duplicate');
    expect(usePlaygroundStore.getState().inputMedia).toEqual(['same.png']);
  });
});
