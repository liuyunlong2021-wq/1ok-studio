/**
 * Tests for model-adaptive video parameter configs.
 *
 * Covers:
 * - I2V_MODELS 配置完整性
 * - 目录里在架视频模型的参数契约（详见「视频模型参数契约」）
 * - GRID_COLS_CLASS 工具映射
 * - 切换模型时的参数重置逻辑
 */
import { describe, it, expect } from 'vitest';
import rawCatalog from '@/generated/modelCatalog.json';
import {
    I2V_MODELS,
    GRID_COLS_CLASS,
    type ModelParamSupport,
} from '@/store/projectStore';

// 本安装的模型选择器只暴露韭菜盒子模型（见 modelCatalog.ts 的
// ALLOWED_MODEL_FAMILIES）。下面的参数契约测试直接读生成的目录数据，
// 断言目录里实际存在的模型，不写死具体模型 id。
const catalogModel = (id: string) => (rawCatalog as any).models[id];

// ── I2V_MODELS 配置完整性 ─────────────────────────────────────────────

describe('I2V_MODELS 配置', () => {
    it('每个模型都包含 params 字段', () => {
        for (const model of I2V_MODELS) {
            expect(model.params).toBeDefined();
            expect(typeof model.params).toBe('object');
        }
    });

    it('每个模型都有唯一 id', () => {
        const ids = I2V_MODELS.map(m => m.id);
        expect(new Set(ids).size).toBe(ids.length);
    });

    it('每个模型都有 duration 配置', () => {
        for (const model of I2V_MODELS) {
            expect(model.duration).toBeDefined();
            expect(['slider', 'buttons', 'fixed']).toContain(model.duration.type);
        }
    });
});

// ── 视频模型参数契约 ──────────────────────────────────────────────────

// 家族收敛后目录里只剩韭菜盒子的视频模型，所以按「目录里带 duration 的模型」逐个
// 校验参数契约；不再给 wan2.6 / wan2.5 / wan2.2 这些已删除的家族写死断言。
const VIDEO_MODELS = Object.entries(rawCatalog.models).filter(
    ([, model]) => (model as { duration?: unknown }).duration
) as [string, { duration: any; params: ModelParamSupport }][];

describe('视频模型参数契约', () => {
    it('目录里确实有视频模型（防止下面的断言空跑）', () => {
        expect(VIDEO_MODELS.map(([id]) => id).sort()).toEqual([
            'dola-seedance2.5',
            'minimax_h3_image_audio_to_video_v2_15s',
            'minimax_h3_zm_u24',
            '海seedance2.5',
        ]);
    });

    it('duration 配置形状合法', () => {
        for (const [id, model] of VIDEO_MODELS) {
            expect(['slider', 'buttons', 'fixed'], `${id}.duration.type`).toContain(model.duration.type);
            if (model.duration.type === 'slider') {
                expect(model.duration.default, `${id}.duration.default`).toBeGreaterThanOrEqual(model.duration.min);
                expect(model.duration.default, `${id}.duration.default`).toBeLessThanOrEqual(model.duration.max);
                expect(model.duration.step, `${id}.duration.step`).toBeGreaterThan(0);
            }
            if (model.duration.type === 'fixed') {
                expect(model.duration.value, `${id}.duration.value`).toBeGreaterThan(0);
            }
            expect(model.params, `${id} 缺少 params`).toBeDefined();
        }
    });

    it('枚举型参数的 default 必须落在 options 内', () => {
        for (const [id, model] of VIDEO_MODELS) {
            for (const key of ['ratio', 'resolution'] as const) {
                const option = model.params[key];
                if (!option) continue;
                expect(option.options.length, `${id}.${key}`).toBeGreaterThan(0);
                expect(option.options, `${id}.${key}`).toContain(option.default);
            }
        }
    });

    it('Seedance 2.5 固定 30 秒，不接受音频输入', () => {
        const model = catalogModel('海seedance2.5');
        expect(model.duration).toEqual({ type: 'fixed', value: 30 });
        expect(model.params.audio).toBeUndefined();
    });

    it('MiniMax H3 两个档位参数一致，且都声明音频输入', () => {
        const h3 = catalogModel('minimax_h3_image_audio_to_video_v2_15s');
        const zm = catalogModel('minimax_h3_zm_u24');
        expect(h3.params).toEqual(zm.params);
        expect(h3.params.audio).toBe(true);
        expect(h3.duration.type).toBe('slider');
    });
});

// ── GRID_COLS_CLASS 映射 ───────────────────────────────────────────────

describe('GRID_COLS_CLASS', () => {
    it('2 列映射为 grid-cols-2', () => {
        expect(GRID_COLS_CLASS[2]).toBe('grid-cols-2');
    });

    it('3 列映射为 grid-cols-3', () => {
        expect(GRID_COLS_CLASS[3]).toBe('grid-cols-3');
    });

    it('4 列映射为 grid-cols-4', () => {
        expect(GRID_COLS_CLASS[4]).toBe('grid-cols-4');
    });

    it('覆盖所有 I2V_MODELS 中实际使用的列数', () => {
        // resolution: 3 cols, mode: 2 cols, movementAmplitude: 4 cols, duration buttons: 2 cols
        const usedCounts = new Set<number>();
        for (const model of I2V_MODELS) {
            const p = model.params;
            if (p.resolution) usedCounts.add(p.resolution.options.length);
            if (p.mode) usedCounts.add(p.mode.options.length);
            if (p.movementAmplitude) usedCounts.add(p.movementAmplitude.options.length);
            if (model.duration.type === 'buttons') {
                usedCounts.add(model.duration.options.length);
            }
        }
        usedCounts.forEach((count) => {
            expect(GRID_COLS_CLASS[count]).toBeDefined();
        });
    });
});

// ── 参数默认值重置逻辑（纯逻辑测试） ──────────────────────────────────

describe('模型切换参数重置逻辑', () => {
    /** 模拟 VideoSidebar 中 updateParam("model", ...) 的重置逻辑 */
    function simulateModelSwitch(targetModelId: string): Record<string, any> {
        const newModelConfig = catalogModel(targetModelId);
        const np = newModelConfig?.params ?? {};
        return {
            resolution: np.resolution?.default ?? "720p",
            ratio: np.ratio?.default ?? "16:9",
            promptExtend: !!np.promptExtend,
            negativePrompt: "",
            shotType: "single",
            generateAudio: false,
            audioUrl: "",
            mode: np.mode?.default ?? "std",
            sound: false,
            cfgScale: np.cfgScale?.default ?? 0.5,
            viduAudio: true,
            movementAmplitude: np.movementAmplitude?.default ?? "auto",
        };
    }

    it('切换到目录默认视频模型 → ratio/resolution 取该模型自己的默认值', () => {
        const id = rawCatalog.defaults.model_settings.r2v_model;
        const np = catalogModel(id).params;
        const result = simulateModelSwitch(id);

        expect(result.ratio).toBe(np.ratio?.default ?? '16:9');
        expect(result.resolution).toBe(np.resolution?.default ?? '720p');
    });

    it('切换模型会清掉上一模型的音频与负向提示', () => {
        const result = simulateModelSwitch('minimax_h3_image_audio_to_video_v2_15s');

        expect(result.negativePrompt).toBe('');
        expect(result.audioUrl).toBe('');
        expect(result.generateAudio).toBe(false);
        expect(result.sound).toBe(false);
        expect(result.shotType).toBe('single');
    });

    it('未声明 promptExtend 的模型 → 关闭增强', () => {
        const model = catalogModel('海seedance2.5');
        expect(model.params.promptExtend).toBeUndefined();
        expect(simulateModelSwitch('海seedance2.5').promptExtend).toBe(false);
    });
});
