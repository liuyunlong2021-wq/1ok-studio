/**
 * 项目步骤表 —— 重点是插入「声音」步骤之后的编号与跳过逻辑。
 *
 * 一个新增步骤最容易出错的地方不是组件本身，而是步骤表：freeform 模式要跳过
 * 「剧本」并把编号重排，legacy 流程一步都不能动。
 */
import { describe, expect, it } from 'vitest';

import { LEGACY_STEPS, UNIFIED_STEPS, stepsForWorkflow } from '@/lib/projectSteps';

const r2v = { workflowMode: 'r2v', seriesContentMode: 'scripted' };

describe('项目步骤表', () => {
    describe('r2v 统一流程', () => {
        it('步骤顺序是 剧本 → 风格 → Cast → 声音 → 分镜 → 合成', () => {
            expect(stepsForWorkflow(r2v).map((step) => step.id)).toEqual([
                'script',
                'art_direction',
                'cast',
                'sound',
                'storyboard_r2v',
                'assembly',
            ]);
        });

        it('「声音」插在 Cast 与分镜之间', () => {
            const ids = stepsForWorkflow(r2v).map((step) => step.id);
            expect(ids.indexOf('sound')).toBe(ids.indexOf('cast') + 1);
            expect(ids.indexOf('sound')).toBe(ids.indexOf('storyboard_r2v') - 1);
        });

        it('标签编号连续（1.…6.），插入后后面的步骤自动重排', () => {
            const labels = stepsForWorkflow(r2v).map((step) => step.label);
            labels.forEach((label, index) => {
                expect(label.startsWith(`${index + 1}.`), label).toBe(true);
            });
            expect(labels[3]).toBe('4. 声音');
            expect(labels[4]).toBe('5. 分镜');
            expect(labels[5]).toBe('6. 合成');
        });
    });

    describe('freeform 模式', () => {
        const freeform = { workflowMode: 'r2v', seriesContentMode: 'freeform' };

        it('跳过「剧本」步骤，编号从 1 重新排', () => {
            const steps = stepsForWorkflow(freeform);
            expect(steps.map((step) => step.id)).not.toContain('script');
            expect(steps[0].label).toBe('1. 风格');
            steps.forEach((step, index) => {
                expect(step.label.startsWith(`${index + 1}.`), step.label).toBe(true);
            });
        });

        it('仍然包含「声音」步骤', () => {
            expect(stepsForWorkflow(freeform).map((step) => step.id)).toContain('sound');
        });
    });

    describe('legacy 流程', () => {
        it('仍是原来的步骤表，不含「声音」—— 老项目行为一个字节都不变', () => {
            const steps = stepsForWorkflow({ workflowMode: 'i2v_legacy' });
            expect(steps).toBe(LEGACY_STEPS);
            expect(steps.map((step) => step.id)).toEqual([
                'script',
                'art_direction',
                'assets',
                'storyboard',
                'motion',
                'assembly',
            ]);
            expect(steps.map((step) => step.id)).not.toContain('sound');
        });

        it('workflow_mode 缺失（老项目）也走 legacy', () => {
            expect(stepsForWorkflow({ workflowMode: null })).toBe(LEGACY_STEPS);
        });
    });

    describe('可跳过性（这一步是纯可选参考）', () => {
        it('步骤表里的「声音」不带预置状态 —— 不会一上来就锁住后面的分镜', () => {
            const sound = UNIFIED_STEPS.find((step) => step.id === 'sound');
            expect(sound).toBeDefined();
            expect(sound?.status).toBeUndefined();
        });

        it('分镜与合成都排在「声音」之后，顺序不受它影响', () => {
            const ids = UNIFIED_STEPS.map((step) => step.id);
            expect(ids.indexOf('storyboard_r2v')).toBeGreaterThan(ids.indexOf('sound'));
            expect(ids.indexOf('assembly')).toBeGreaterThan(ids.indexOf('storyboard_r2v'));
        });
    });
});
