/**
 * 创作台的模型列表：目录里「已登记、但当前账号/渠道还没有」的模型不能摆出来。
 *
 * 判据就是目录里的 `status: hidden` + `visible_in: []`（Fk MiniMax H3 就是这么登记的，
 * 因为认证时网关 /v1/models 不返回它）。摆出来用户会真的点下去，然后撞网关 503
 * 「无可用渠道：该模型由任务插件认领，但当前没有启用的渠道可服务此模型」。
 */
import { describe, expect, it } from 'vitest';

import { getModelsForMode } from '@/components/modules/playground/playgroundModels';

/** Fk MiniMax H3 768P：已登记、账号未开通 → 不能出现在创作台。 */
const FK_H3_UNAVAILABLE = 'ft-video-v1-77e8ee7a636f15dac27b2ce6d6fcd746';

describe('创作台模型列表', () => {
  it('不给未开通的 Fk MiniMax H3，但保留 Fk 通道其余 7 款', () => {
    const r2v = getModelsForMode('r2v').map((model) => model.id);

    expect(r2v).not.toContain(FK_H3_UNAVAILABLE);
    expect(r2v.filter((id) => id.startsWith('ft-video-v1-'))).toHaveLength(7);
  });

  it('其他视频模式里也不会漏出来', () => {
    for (const mode of ['t2v', 'i2v', 'v2v'] as const) {
      expect(getModelsForMode(mode).map((model) => model.id)).not.toContain(FK_H3_UNAVAILABLE);
    }
  });
});
