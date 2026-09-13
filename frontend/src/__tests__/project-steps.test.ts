/**
 * 「声音」步骤（一期）的步骤表规格 —— **待实现**。
 *
 * 现在步骤表硬编码在 `components/project/ProjectClient.tsx` 里，测不到。一期会把
 * 它抽到 `@/lib/projectSteps`，导出：
 *
 *   UNIFIED_STEPS / LEGACY_STEPS
 *   stepsForWorkflow({ workflowMode, seriesContentMode }): Step[]
 *
 * 抽出后下面这些 todo 就变成真实断言。
 *
 * 为什么先写它：插入一个新步骤最容易出错的地方不是组件本身，而是**编号和跳过逻辑**
 * —— freeform 模式要跳过「剧本」并把编号重排，legacy 流程一步都不能动。
 */
import { describe, it } from 'vitest';

describe('项目步骤表', () => {
    describe('r2v 统一流程', () => {
        it.todo('步骤顺序是 剧本 → 风格 → Cast → 声音 → 分镜 → 合成');
        it.todo('「声音」插在 Cast 与分镜之间，id 为 "sound"');
        it.todo('标签编号连续（1.…6.），插入后后面的步骤自动重排');
    });

    describe('freeform 模式', () => {
        it.todo('跳过「剧本」步骤，编号从 1 重新排');
        it.todo('仍然包含「声音」步骤');
    });

    describe('legacy 流程', () => {
        it.todo('仍是原来的步骤表，不含「声音」—— 老项目行为一个字节都不变');
    });

    describe('可跳过性（这一步是纯可选参考）', () => {
        it.todo('「声音」的步骤状态只有 idle / ready，永不 gated');
        it.todo('没有 audio_plan 时「分镜」「合成」照常可用');
    });
});
