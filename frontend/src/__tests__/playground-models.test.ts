/**
 * 创作台的模型列表过滤规则。
 *
 * 规则（`playgroundModels.ts::getModelsForMode`）：排除 deprecated/planned；
 * 并排除 **hidden 且 `visible_in` 为空** —— 那是「已登记、但当前账号/渠道还没开通」的模型。
 * 摆出来用户会真点下去，然后撞网关 503「无可用渠道」。Fk MiniMax H3 就这样来回切过一次
 * （渠道未开通时 hidden + 空 visible_in，开通后改回 active + 4 个界面）。
 *
 * 因此这里**不写死任何模型 id 或数量**，而是每次都从目录现算一份期望集合：
 * 渠道开关变化时测试不用改，规则坏了却一定红。
 */
import { describe, expect, it } from 'vitest';

import rawCatalog from '@/generated/modelCatalog.json';
import { getModelsForMode } from '@/components/modules/playground/playgroundModels';

/** 创作台支持的模式（从函数签名取，别另外维护一份）。 */
type Mode = Parameters<typeof getModelsForMode>[0];

type RawModel = {
  id: string;
  status?: string;
  capabilities?: string[];
  ui?: { visible_in?: string[] };
};

const catalogModels = Object.values((rawCatalog as { models: Record<string, RawModel> }).models);

/** 目录里「够格出现在创作台」的模型 id：规则的第二份实现，故意写得笨一点。 */
function eligibleIds(mode: Mode): string[] {
  return catalogModels
    .filter((model) => {
      if (model.status === 'deprecated' || model.status === 'planned') return false;
      if (model.status === 'hidden' && (model.ui?.visible_in?.length ?? 0) === 0) return false;
      return (model.capabilities ?? []).includes(mode);
    })
    .map((model) => model.id);
}

/** 目录驱动的模式；t2a/r2a 写死在代码里（seed-audio-1.0 不在目录中），不参与目录对照。 */
const MODES: Mode[] = ['t2i', 'i2i', 't2v', 'i2v', 'r2v', 'v2v'];
const ALL_MODES: Mode[] = [...MODES, 't2a', 'r2a'];

describe('创作台模型列表', () => {
  it('每个模式给出的模型 = 目录里够格的那些，不多不少', () => {
    for (const mode of MODES) {
      const actual = getModelsForMode(mode).map((model) => model.id);
      expect([...actual].sort(), `${mode} 的列表与目录不符`).toEqual([...eligibleIds(mode)].sort());
    }
  });

  it('未开通的模型（hidden 且 visible_in 为空）一个都不能漏出来', () => {
    const unavailable = catalogModels
      .filter((m) => m.status === 'hidden' && (m.ui?.visible_in?.length ?? 0) === 0)
      .map((m) => m.id);

    for (const mode of ALL_MODES) {
      const shown = getModelsForMode(mode).map((model) => model.id);
      for (const id of unavailable) {
        expect(shown, `${id} 未开通，不该出现在 ${mode}`).not.toContain(id);
      }
    }
  });
});
