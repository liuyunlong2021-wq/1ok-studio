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
        // Defaults follow the catalog upgrade to wan2.7 (Phase 2, 2026-Q1).
        // The unified `image_model` surface replaces the per-mode t2i/i2i
        // settings at the consumer layer.
        expect(DEFAULT_MODEL_SETTINGS).toMatchObject({
            t2i_model: 'wan2.7-image-pro',
            i2i_model: 'wan2.7-image-pro',
            i2v_model: 'happyhorse-1.1-i2v',
            image_model: 'wan2.7-image-pro',
            text_model: 'gpt-5.6-sol',
        });

        // The 't2i' and 'i2i' selection_group surfaces moved to 'image'
        // in Phase 2. The resolver now falls through to visible image-group
        // models so user picks (e.g. Wan 2.7 Image Pro) persist through
        // resolveModelId() instead of silently reverting to the default.
        expect(GLOBAL_T2I_MODELS.map((model) => model.id)).toEqual(GLOBAL_IMAGE_MODELS.map((m) => m.id));
        expect(GLOBAL_I2I_MODELS.map((model) => model.id)).toEqual(GLOBAL_IMAGE_MODELS.map((m) => m.id));

        // Ordered DESC by ui.order; ties broken by display_name asc.
        // 本安装只接韭菜盒子网关（modelCatalog.ts 的 ALLOWED_MODEL_FAMILIES），
        // 而目录里的 i2v 模型全是别家（happyhorse / kling / pixverse / seedance /
        // wan / vidu）→ 选择器为空是**刻意的**：这些模型的凭证没配（DashScope
        // key 是占位符），留在列表里只会让用户选中后失败。
        expect(GLOBAL_I2V_MODELS).toEqual([]);
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
        // 反向确认：r2v 组确实留下了韭菜盒子的两个模型，不是被误清空
        expect(VIDEO_R2V_MODELS.map((model) => model.id).sort()).toEqual([
            'dola-seedance2.5',
            'minimax_h3_image_audio_to_video_v2_15s',
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
        // 本安装只接韭菜盒子网关（modelCatalog.ts 的 ALLOWED_MODEL_FAMILIES），
        // 所以「目录默认值」wan2.7-image-pro / happyhorse-1.1-i2v 不再可达：
        // 未知 id 落到允许家族里排序最靠前的 image 模型（grok，order=1001）。
        // i2v 组允许家族为空 → 保留目录默认值（该字段在本安装里是惰性的）。
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
            t2i_model: 'jiucaihezi/grok-imagine-image-2.0',
            i2i_model: 'jiucaihezi/grok-imagine-image-2.0',
            i2v_model: 'happyhorse-1.1-i2v',
        });

        // 真实世界的脏数据：老项目里存的就是这两个（output/projects.json）。
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
        expect(stale.t2i_model).toBe('jiucaihezi/grok-imagine-image-2.0');
        expect(stale.image_model).toBe('jiucaihezi/grok-imagine-image-2.0');
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
        // out by the visibility check and the resolver falls back to the first
        // allowed i2v model. 本安装只接韭菜盒子，而韭菜盒子没有 i2v 模型，
        // 所以 i2v 组为空 → 回落链最终停在目录默认值 happyhorse-1.1-i2v。
        expect(
            resolveCompatModelSettings(
                {
                    i2v_model: 'wan/wan2.6-video#i2v',
                },
                'global_settings'
            ).i2v_model
        ).toBe('happyhorse-1.1-i2v');

        // An r2v canonical id normalizes to the matching legacy id
        // (wan2.6-r2v), which is hidden in the i2v surface — so the
        // resolver falls back to the i2v default (happyhorse-1.1-i2v).
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
        ).toBe('happyhorse-1.1-i2v');

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
        // getMaxReferenceImages routes the input through resolveModelId
        // for the 'i2i' surface — when the literal id isn't visible in
        // that surface (post-Phase 2 the wan2.6 ids moved to the
        // 'image' selection_group, and 本安装 only allows 韭菜盒子), the
        // resolver falls back to the top visible image model
        // (jiucaihezi/grok-imagine-image-2.0, which advertises 8 refs).
        // The behavior is correct given how callers (PropertiesPanel)
        // use the project's i2i_model setting.
        expect(getMaxReferenceImages('wan2.6-image')).toBe(8);
        expect(getMaxReferenceImages('wan2.5-i2i-preview')).toBe(8);
    });
});

describe('model catalog phase 2 canonical helpers', () => {
    it('resolves legacy flat id to canonical mode id', () => {
        expect(getCanonicalModeId('wan2.6-i2v')).toBe('wan/wan2.6-video#i2v');
        expect(getCanonicalModeId('wan2.6-r2v')).toBe('wan/wan2.6-video#r2v');
        expect(getCanonicalModeId('nonexistent')).toBeUndefined();
    });

    it('resolves canonical mode id back to legacy flat id', () => {
        expect(getLegacyModelId('wan/wan2.6-video#i2v')).toBe('wan2.6-i2v');
        expect(getLegacyModelId('wan/wan2.6-video#r2v')).toBe('wan2.6-r2v');
        expect(getLegacyModelId('nonexistent')).toBeUndefined();
    });

    it('reads canonical mode entry with full metadata', () => {
        const entry = getCanonicalModeEntry('wan/wan2.6-video#i2v');
        expect(entry).not.toBeNull();
        expect(entry?.model_line_id).toBe('wan/wan2.6-video');
        expect(entry?.legacy_model_id).toBe('wan2.6-i2v');
        expect(entry?.mode).toBe('i2v');
        expect(entry?.family).toBe('wan');

        expect(getCanonicalModeEntry('nonexistent')).toBeNull();
    });

    it('reads model line entry', () => {
        const line = getModelLineEntry('wan/wan2.6-video');
        expect(line).not.toBeNull();
        expect(line?.family).toBe('wan');
        expect(line?.modes).toContain('wan/wan2.6-video#i2v');
        expect(line?.modes).toContain('wan/wan2.6-video#r2v');
        expect(line?.legacy_model_ids).toContain('wan2.6-i2v');

        expect(getModelLineEntry('nonexistent')).toBeNull();
    });

    it('reads gateway metadata from canonical mode runtime', () => {
        expect(getModeGateway('wan/wan2.6-video#r2v')).toBe('dashscope');
        expect(getModeGateway('wan/wan2.6-video#r2v', 'vendor')).toBeUndefined();
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
