import { describe, expect, it } from 'vitest';
import { ZH_SCENE_RE } from './useDerivation';

/**
 * 这条正则只在 sceneHeading 节点上跑（见 `deriveFromDocument`），职责是把
 * 场次标题拆成地点 + 时间。短剧标准化的输出是 `场1-2 别墅客厅 - 日`，必须能过，
 * 否则场景面板里的地点和时间永远是空的。
 */
describe('ZH_SCENE_RE', () => {
  it.each([
    ['场1-2 别墅客厅 - 日', '别墅客厅', '日'],
    ['1-2 别墅客厅 - 日', '别墅客厅', '日'],
    ['别墅客厅 - 夜', '别墅客厅', '夜'],
    ['内景. 办公室 - 日', '办公室', '日'],
  ])('解析 %s', (text, location, timeOfDay) => {
    const match = text.match(ZH_SCENE_RE);

    expect(match?.[1]).toBe(location);
    expect(match?.[2]).toBe(timeOfDay);
  });

  it('不带破折号的行不算场次标题', () => {
    expect('雨点砸在落地窗上。'.match(ZH_SCENE_RE)).toBeNull();
  });
});
