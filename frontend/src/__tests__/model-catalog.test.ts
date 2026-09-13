import rawCatalog from '@/generated/modelCatalog.json';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    DEFAULT_MODEL_SETTINGS,
    DEFAULT_R2V_MODEL_ID,
    GLOBAL_I2I_MODELS,
    GLOBAL_I2V_MODELS,
    GLOBAL_IMAGE_MODELS,
    GLOBAL_R2V_MODELS,
    GLOBAL_T2I_MODELS,
    GLOBAL_TEXT_MODELS,
    PROJECT_I2V_MODELS,
    PROJECT_T2I_MODELS,
    R2V_ROUTE_MODEL_ID,
    R2V_SELECTION_MODEL_ID,
    VIDEO_I2V_MODELS,
    VIDEO_R2V_MODELS,
    getCanonicalDefaults,
    getCanonicalModeEntry,
    getCanonicalModeId,
    getLegacyModelId,
    getMaxReferenceImages,
    getModelLineEntry,
    getModeGateway,
    resolveModelSettings,
} from '@/lib/modelCatalog';

type MockCatalog = Omit<typeof rawCatalog, 'model_lines' | 'modes' | 'compat'> & {
    model_lines?: Record<string, { id: string; family: string }>;
    modes?: Record<string, { id: string; model_line_id: string; mode: string }>;
    compat?: {
        legacy_model_ids?: Record<string, string>;
    };
};

afterEach(() => {
    vi.doUnmock('@/generated/modelCatalog.json');
    vi.resetModules();
});

describe('model catalog selectors', () => {
    it('derives visible model selectors from catalog defaults', () => {
        // 与目录里的默认值对齐，不写死具体模型 id——换默认模型（wan2.7-image-pro
        // 已下线，默认改为 jiucaihezi/gpt-image-2.5-1k）时这里不该失败。
        // The unified `image_model` surface replaces the per-mode t2i/i2i
        // settings at the consumer layer.
        expect(DEFAULT_MODEL_SETTINGS).toMatchObject(rawCatalog.defaults.model_settings);

        // The 't2i' and 'i2i' selection_group surfaces moved to 'image'
        // in Phase 2. The resolver now falls through to visible image-group
        // models so user picks (e.g. Wan 2.7 Image Pro) persist through
        // resolveModelId() instead of silently reverting to the default.
        expect(GLOBAL_T2I_MODELS.map((model) => model.id)).toEqual(GLOBAL_IMAGE_MODELS.map((m) => m.id));
        expect(GLOBAL_I2I_MODELS.map((model) => model.id)).toEqual(GLOBAL_IMAGE_MODELS.map((m) => m.id));

        // Ordered DESC by ui.order; ties broken by display_name asc.
        // i2v 分组现在由韭菜盒子的 r2v 模型填充（同一批模型同时挂在两个分组上）。
        // 只断言「非空 + 只含白名单家族」，不写死具体 id，也不写死空数组。
        expect(GLOBAL_I2V_MODELS.length).toBeGreaterThan(0);
        expect(GLOBAL_I2V_MODELS.every((model) => model.family === 'jiucaihezi')).toBe(true);
    });

    it('所有模型选择器只暴露韭菜盒子（本安装只接该网关）', () => {
        const selectors = [
            GLOBAL_T2I_MODELS,
            GLOBAL_I2I_MODELS,
            GLOBAL_IMAGE_MODELS,
            GLOBAL_I2V_MODELS,
            GLOBAL_R2V_MODELS,
            GLOBAL_TEXT_MODELS,
            PROJECT_T2I_MODELS,
            PROJECT_I2V_MODELS,
            VIDEO_I2V_MODELS,
            VIDEO_R2V_MODELS,
        ];

        for (const models of selectors) {
            expect(models.every((model) => model.family === 'jiucaihezi')).toBe(true);
        }
        // 反向确认：r2v 组确实留下了韭菜盒子的模型，不是被误清空
        expect(VIDEO_R2V_MODELS.map((model) => model.id).sort()).toEqual([
            'dola-seedance2.5',
            'minimax_h3_image_audio_to_video_v2_15s',
            'minimax_h3_zm_u24',
        ]);
        // 默认必须是 dola-seedance2.5（列表顺序是按 ui.order 排的，不是默认值）
        expect(DEFAULT_R2V_MODEL_ID).toBe('dola-seedance2.5');
    });

    it('exposes Grok image generation and editing without resetting the selection', () => {
        const id = 'jiucaihezi/grok-imagine-image-2.0';
        expect(GLOBAL_IMAGE_MODELS.some(model => model.id === id)).toBe(true);
        for (const surface of ['global_settings', 'project_settings', 'series_settings'] as const) {
            expect(resolveModelSettings({ image_model: id, t2i_model: id, i2i_model: id }, surface))
                .toMatchObject({ image_model: id, t2i_model: id, i2i_model: id });
        }
    });

    it('keeps hidden and planned catalog entries out of visible selectors', () => {
        expect(GLOBAL_I2V_MODELS.some((model) => model.id === 'wan2.6-r2v')).toBe(false);
        expect(GLOBAL_I2V_MODELS.some((model) => model.id === 'pixverse-v4-i2v')).toBe(false);
    });
});

describe('model catalog fallbacks', () => {
    it('falls back unknown and legacy-surface ids to catalog defaults', () => {
        // 本安装只接韭菜盒子网关（modelCatalog.ts 的 ALLOWED_MODEL_FAMILIES）。
        // 兜底顺序：目录默认值（只要它在白名单里且可见）→ 否则可见列表首个。
        // 目录默认值已改为 jiucaihezi/gpt-image-2.5-1k，它在白名单内，所以
        // 未知 id 会落到它身上，不再绕到 grok。断言直接读目录，不写死 id。
        const imageDefault = rawCatalog.defaults.model_settings.i2i_model;
        expect(
            resolveModelSettings(
                {
                    t2i_model: 'missing-model',
                    i2i_model: 'wan2.6-r2v',
                    i2v_model: 'missing-video-model',
                },
                'global_settings'
            )
        ).toMatchObject({
            t2i_model: imageDefault,
            i2i_model: imageDefault,
            i2v_model: rawCatalog.defaults.model_settings.i2v_model,
        });

        // 真实世界的脏数据：老项目里存的就是 wan2.7-image-pro（该模型已从目录删除），
        // 读项目时必须落到韭菜盒子的 image 模型上，否则生图会打 DashScope 拿 401。
        const stale = resolveModelSettings(
            {
                t2i_model: 'wan2.7-image-pro',
                i2i_model: 'wan2.7-image-pro',
                image_model: 'wan2.7-image-pro',
                i2v_model: 'happyhorse-1.1-i2v',
                r2v_model: 'happyhorse-1.1-r2v',
                text_model: 'gpt-5.6-sol',
            },
            'project_settings'
        );
        expect(stale.t2i_model).toBe(imageDefault);
        expect(stale.image_model).toBe(imageDefault);
        expect(stale.r2v_model).toBe('dola-seedance2.5');
        expect(stale.text_model).toBe('gpt-5.6-sol');
        // 韭菜盒子自家的模型即使不在该分组里也要保留：项目把 r2v 的
        // dola-seedance2.5 存进了 i2v_model，若走分组兜底会换成 happyhorse
        // （没配密钥）→ 生成必定 401。旧值还带家族前缀，要一并归一化成目录 key。
        expect(resolveModelSettings({ i2v_model: 'dola-seedance2.5' }, 'project_settings').i2v_model)
            .toBe('dola-seedance2.5');
        expect(resolveModelSettings({ i2v_model: 'jiucaihezi/dola-seedance2.5' }, 'project_settings').i2v_model)
            .toBe('dola-seedance2.5');
    });

    it('normalizes canonical mode ids back to legacy compatibility ids when compat metadata exists', async () => {
        const catalogWithCompat = structuredClone(rawCatalog) as MockCatalog;
        catalogWithCompat.model_lines = {
            'wan/wan2.6-image': {
                id: 'wan/wan2.6-image',
                family: 'wan',
            },
            'wan/wan2.6-video': {
                id: 'wan/wan2.6-video',
                family: 'wan',
            },
        };
        catalogWithCompat.modes = {
            'wan/wan2.6-image#i2i': {
                id: 'wan/wan2.6-image#i2i',
                model_line_id: 'wan/wan2.6-image',
                mode: 'i2i',
            },
            'wan/wan2.6-video#i2v': {
                id: 'wan/wan2.6-video#i2v',
                model_line_id: 'wan/wan2.6-video',
                mode: 'i2v',
            },
            'wan/wan2.6-video#r2v': {
                id: 'wan/wan2.6-video#r2v',
                model_line_id: 'wan/wan2.6-video',
                mode: 'r2v',
            },
        };
        catalogWithCompat.compat = {
            legacy_model_ids: {
                'wan2.6-image': 'wan/wan2.6-image#i2i',
                'wan2.6-i2v': 'wan/wan2.6-video#i2v',
                'wan2.6-r2v': 'wan/wan2.6-video#r2v',
            },
        };

        vi.doMock('@/generated/modelCatalog.json', () => ({
            default: catalogWithCompat,
        }));

        const {
            GLOBAL_I2V_MODELS: compatI2vModels,
            R2V_ROUTE_MODEL_ID: compatR2vRouteModelId,
            R2V_SELECTION_MODEL_ID: compatR2vSelectionModelId,
            resolveModelSettings: resolveCompatModelSettings,
        } = await import('@/lib/modelCatalog');

        // After 524f3a1 deprecated the wan2.6 series, 'wan2.6-i2v' is hidden
        // (visible_in: []), so the canonical → legacy normalization is filtered
        // out by the visibility check and the resolver falls back to the
        // catalog default i2v model.
        expect(
            resolveCompatModelSettings(
                {
                    i2v_model: 'wan/wan2.6-video#i2v',
                },
                'global_settings'
            ).i2v_model
        ).toBe(rawCatalog.defaults.model_settings.i2v_model);

        // An r2v canonical id normalizes to the matching legacy id
        // (wan2.6-r2v), which is hidden in the i2v surface — so the
        // resolver falls back to the i2v default.
        // Previously this assertion expected the resolver to remap r2v into
        // the parent i2v legacy id; that behavior was dropped when r2v ids
        // gained explicit modality suffixes.
        expect(
            resolveCompatModelSettings(
                {
                    i2v_model: 'wan/wan2.6-video#r2v',
                },
                'global_settings'
            ).i2v_model
        ).toBe(rawCatalog.defaults.model_settings.i2v_model);

        expect(compatI2vModels.map((model) => model.id)).not.toContain('wan2.6-i2v');
        expect(compatI2vModels.some((model) => model.id === 'wan/wan2.6-video#i2v')).toBe(false);
        // R2V selection/route ids resolve to PREFERRED_R2V_MODEL_ID (dola-seedance2.5):
        // 白名单只留下韭菜盒子，目录默认 happyhorse-1.1-r2v 被滤掉，所以显式钉住
        // 用户实际在跑的模型，而不是让默认值漂到 ui.order 最高的 minimax。
        // Selection and route are unified (R2V_ROUTE_MODEL_ID = R2V_SELECTION_MODEL_ID).
        expect(compatR2vSelectionModelId).toBe('dola-seedance2.5');
        expect(compatR2vRouteModelId).toBe('dola-seedance2.5');
    });
});

describe('model catalog runtime helpers', () => {
    it('derives the current R2V selection and route ids from catalog data', () => {
        // 固定为 PREFERRED_R2V_MODEL_ID（dola-seedance2.5），不是列表首个：
        // 列表按 ui.order 排序，会漂到 minimax_h3…（order=1001）。
        expect(R2V_SELECTION_MODEL_ID).toBe('dola-seedance2.5');
        expect(R2V_ROUTE_MODEL_ID).toBe('dola-seedance2.5');
    });

    it('reads per-model reference image limits from catalog metadata', () => {
        // 声明了上限的模型读它自己的值。
        expect(getMaxReferenceImages('jiucaihezi/grok-imagine-image-2.0')).toBe(8);

        // 没声明的模型回落到代码里的保守默认值。注意 getMaxReferenceImages 会先过
        // 一层 resolveModelId('i2i')：旧 id（wan2.6-image 等）不在白名单里，会落到
        // 目录默认模型上，所以这里跟着目录走，不写死数字。
        const resolvedDefault = rawCatalog.defaults.model_settings.i2i_model;
        const declared = (rawCatalog.models as Record<string, { inputs?: { reference_images?: { max?: number } } }>)[
            resolvedDefault
        ]?.inputs?.reference_images?.max;
        const expected = typeof declared === 'number' ? declared : 3;
        expect(getMaxReferenceImages('wan2.6-image')).toBe(expected);
        expect(getMaxReferenceImages('wan2.5-i2i-preview')).toBe(expected);
    });
});

describe('model catalog phase 2 canonical helpers', () => {
    // 全部从当前目录推导（默认 r2v 模型），不写死已删除的 wan2.6 系列 id。
    const legacyId = rawCatalog.defaults.model_settings.r2v_model;
    const canonicalId = rawCatalog.compat.legacy_model_ids[legacyId as keyof typeof rawCatalog.compat.legacy_model_ids];
    const mode = rawCatalog.modes[canonicalId as keyof typeof rawCatalog.modes];
    const lineId = mode.model_line_id;
    const family = mode.family;
    const runtime = mode.runtime as Record<string, { gateway: string }>;
    // getModeGateway 的 backend 默认值是 'dashscope'；单家族产品必须显式传后端。
    const backend = Object.keys(runtime)[0];

    it('resolves legacy flat id to canonical mode id', () => {
        expect(getCanonicalModeId(legacyId)).toBe(canonicalId);
        expect(getCanonicalModeId('nonexistent')).toBeUndefined();
    });

    it('resolves canonical mode id back to legacy flat id', () => {
        expect(getLegacyModelId(canonicalId)).toBe(legacyId);
        expect(getLegacyModelId('nonexistent')).toBeUndefined();
    });

    it('reads canonical mode entry with full metadata', () => {
        const entry = getCanonicalModeEntry(canonicalId);
        expect(entry).not.toBeNull();
        expect(entry?.model_line_id).toBe(lineId);
        expect(entry?.legacy_model_id).toBe(legacyId);
        expect(entry?.mode).toBe(mode.mode);
        expect(entry?.family).toBe(family);

        expect(getCanonicalModeEntry('nonexistent')).toBeNull();
    });

    it('reads model line entry', () => {
        const line = getModelLineEntry(lineId);
        expect(line).not.toBeNull();
        expect(line?.family).toBe(family);
        expect(line?.modes).toContain(canonicalId);
        expect(line?.legacy_model_ids).toContain(legacyId);

        expect(getModelLineEntry('nonexistent')).toBeNull();
    });

    it('reads gateway metadata from canonical mode runtime', () => {
        expect(getModeGateway(canonicalId, backend)).toBe(runtime[backend].gateway);
        expect(getModeGateway(canonicalId, 'vendor')).toBeUndefined();
        expect(getModeGateway('nonexistent')).toBeUndefined();
    });

    it('reads canonical default model settings', () => {
        const defaults = getCanonicalDefaults();
        expect(defaults.t2i_model).toContain('#');
        expect(defaults.i2i_model).toContain('#');
        expect(defaults.i2v_model).toContain('#');
    });

    it('does not leak canonical ids into visible flat model selectors', () => {
        for (const model of GLOBAL_I2V_MODELS) {
            expect(model.id).not.toContain('#');
        }
        for (const model of GLOBAL_T2I_MODELS) {
            expect(model.id).not.toContain('#');
        }
        for (const model of GLOBAL_I2I_MODELS) {
            expect(model.id).not.toContain('#');
        }
    });
});
