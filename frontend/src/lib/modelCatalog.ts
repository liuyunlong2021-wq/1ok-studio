import rawCatalog from '@/generated/modelCatalog.json';

export type DurationConfig =
    | { type: 'slider'; min: number; max: number; step: number; default: number }
    | { type: 'buttons'; options: number[]; default: number }
    | { type: 'fixed'; value: number };

export interface ModelParamSupport {
    resolution?: { options: string[]; default: string };
    ratio?: { options: string[]; default: string };
    seed?: boolean;
    negativePrompt?: boolean;
    promptExtend?: boolean;
    shotType?: boolean | { options: string[]; default: string };
    audio?: boolean;
    mode?: { options: string[]; default: string };
    sound?: boolean;
    cfgScale?: { min: number; max: number; step: number; default: number };
    viduAudio?: boolean;
    movementAmplitude?: { options: string[]; default: string };
    watermark?: boolean;
}

export interface I2VModelConfig {
    id: string;
    name: string;
    description: string;
    duration: DurationConfig;
    params: ModelParamSupport;
    badges?: string[];
    recommended?: boolean;
    family?: string;
    status?: string;
}

export interface SelectableModelOption {
    id: string;
    name: string;
    description: string;
    badges?: string[];
    recommended?: boolean;
    family?: string;
    status?: string;
}

export type ModelOption = SelectableModelOption;

export interface FrontendModelSettings {
    text_model: string;
    t2i_model: string;
    i2i_model: string;
    image_model: string;
    i2v_model: string;
    /** Project-level R2V default. Storyboard's R2V tab uses it as
     *  initial value; per-storyboard localStorage override still wins.
     *  Optional on the wire so older project files still parse. */
    r2v_model?: string;
    character_aspect_ratio: string;
    scene_aspect_ratio: string;
    prop_aspect_ratio: string;
    storyboard_aspect_ratio: string;
}

type SelectionGroup = 'text' | 't2i' | 'i2i' | 'image' | 'i2v' | 'r2v';
type ModelStatus = 'active' | 'planned' | 'deprecated' | 'hidden';
type SettingsSurface = 'project_settings' | 'series_settings' | 'global_settings';
type VisibilitySurface = SettingsSurface | 'video_sidebar';

interface CatalogModel {
    id: string;
    display_name: string;
    description: string;
    family: string;
    status: ModelStatus;
    capabilities: string[];
    duration?: DurationConfig | null;
    params?: ModelParamSupport;
    inputs?: {
        reference_images?: {
            max?: number;
        };
        [key: string]: unknown;
    };
    ui: {
        selection_group: SelectionGroup;
        visible_in: VisibilitySurface[];
        recommended?: boolean;
        order?: number;
        badges?: string[];
    };
}

interface ModelCatalog {
    defaults: {
        model_settings: {
            t2i_model: string;
            i2i_model: string;
            image_model: string;
            i2v_model: string;
            text_model: string;
        };
        canonical_model_settings?: {
            t2i_model?: string;
            i2i_model?: string;
            image_model?: string;
            i2v_model?: string;
        };
    };
    models: Record<string, CatalogModel>;
    model_lines: Record<
        string,
        {
            id: string;
            family: string;
            modes: string[];
            legacy_model_ids: string[];
            runtime?: Record<string, Record<string, unknown>>;
            [key: string]: unknown;
        }
    >;
    modes: Record<
        string,
        {
            id: string;
            model_line_id: string;
            legacy_model_id: string;
            mode: string;
            family: string;
            status: ModelStatus;
            capabilities: string[];
            runtime: Record<string, Record<string, unknown>>;
            ui: {
                selection_group: SelectionGroup;
                visible_in: VisibilitySurface[];
                recommended?: boolean;
                order?: number;
                badges?: string[];
            };
            [key: string]: unknown;
        }
    >;
    compat: {
        legacy_model_ids: Record<string, string>;
    };
}

const MODEL_CATALOG = rawCatalog as ModelCatalog;
const CATALOG_MODELS = Object.values(MODEL_CATALOG.models);
const LEGACY_MODEL_ID_ALIASES = MODEL_CATALOG.compat.legacy_model_ids;
const CANONICAL_MODEL_ID_ALIASES = Object.freeze(
    Object.fromEntries(
        Object.entries(LEGACY_MODEL_ID_ALIASES).map(([legacyModelId, canonicalModeId]) => [
            canonicalModeId,
            legacyModelId,
        ])
    ) as Record<string, string>
);

// ---------------------------------------------------------------------------
// Phase 2: Canonical mode internal helpers
// ---------------------------------------------------------------------------

/** Resolve a legacy flat ID to its canonical mode ID, or undefined. */
export function getCanonicalModeId(legacyId: string): string | undefined {
    return LEGACY_MODEL_ID_ALIASES[legacyId];
}

/** Resolve a canonical mode ID back to its legacy flat ID, or undefined. */
export function getLegacyModelId(canonicalModeId: string): string | undefined {
    return CANONICAL_MODEL_ID_ALIASES[canonicalModeId];
}

/** Get the canonical mode entry for a mode ID. */
export function getCanonicalModeEntry(canonicalModeId: string) {
    return MODEL_CATALOG.modes[canonicalModeId] ?? null;
}

/** Get the model line entry for a model line ID. */
export function getModelLineEntry(modelLineId: string) {
    return MODEL_CATALOG.model_lines[modelLineId] ?? null;
}

/** Get the gateway value for a canonical mode on a backend. */
export function getModeGateway(
    canonicalModeId: string,
    backend: string = 'dashscope'
): string | undefined {
    const mode = MODEL_CATALOG.modes[canonicalModeId];
    if (!mode) return undefined;
    const backendMeta = mode.runtime?.[backend];
    if (!backendMeta) return undefined;
    return backendMeta.gateway as string | undefined;
}

/** Get canonical default model settings. */
export function getCanonicalDefaults(): Record<string, string> {
    return { ...(MODEL_CATALOG.defaults.canonical_model_settings ?? {}) };
}

const DEFAULT_ASPECT_RATIOS = Object.freeze({
    character_aspect_ratio: '9:16',
    scene_aspect_ratio: '16:9',
    prop_aspect_ratio: '1:1',
    storyboard_aspect_ratio: '16:9',
});

export const DEFAULT_MODEL_SETTINGS: FrontendModelSettings = Object.freeze({
    ...MODEL_CATALOG.defaults.model_settings,
    ...DEFAULT_ASPECT_RATIOS,
});

const SORTED_MODEL_ENTRIES = [...CATALOG_MODELS].sort((left, right) => {
    const orderDelta = (right.ui.order ?? 0) - (left.ui.order ?? 0);
    if (orderDelta !== 0) {
        return orderDelta;
    }
    return left.display_name.localeCompare(right.display_name);
});

// 本安装只接韭菜盒子网关：其他 provider（DashScope 的 wan/qwen、Kling、Pixverse…）
// 在这份 .env 里没有可用凭证，选中后必定失败（实测 DASHSCOPE_API_KEY 是占位符 → 401）。
// 过滤点只有一个：getVisibleModels()。选择器列表和 resolveModelId() 都走它，
// 所以"项目里存的旧 id"（wan2.7-image-pro / happyhorse-1.1-r2v）也会落到允许家族上。
// 想恢复完整目录：把下面这行改成 `const ALLOWED_MODEL_FAMILIES: string[] | null = null;`
const ALLOWED_MODEL_FAMILIES: string[] | null = ['jiucaihezi'];

/** R2V 默认模型。目录默认值 happyhorse-1.1-r2v 不在白名单里，所以显式指定。 */
const PREFERRED_R2V_MODEL_ID = 'dola-seedance2.5';

function onlyAllowedModels(models: CatalogModel[]): CatalogModel[] {
    const allowed = ALLOWED_MODEL_FAMILIES;
    return allowed ? models.filter((model) => allowed.includes(model.family)) : models;
}

function isVisibleModel(model: CatalogModel, surface: VisibilitySurface): boolean {
    return (
        model.status !== 'planned' &&
        model.status !== 'deprecated' &&
        model.status !== 'hidden' &&
        model.ui.visible_in.includes(surface)
    );
}

function getVisibleModels(group: SelectionGroup, surface: VisibilitySurface): CatalogModel[] {
    // 本安装只接韭菜盒子网关，所以「可见」= 目录可见 && 在允许家族内。
    // 过滤放在这里而不是各个选择器里，是为了让 resolveModelId() 的兜底逻辑
    // 也一起生效：项目里存的旧模型 id（如 wan2.7-image-pro / happyhorse-1.1-i2v）
    // 会落到允许家族的同组模型上，而不是继续调用没配密钥的别家网关。
    // Strict match: model declared its primary selection_group as `group`.
    const direct = SORTED_MODEL_ENTRIES.filter(
        (model) => model.ui.selection_group === group && isVisibleModel(model, surface)
    );
    // Capability fallback: when the strict bucket is empty for t2i/i2i (the
    // current catalog ships only `image`-group models that can do both),
    // accept any visible image-group model that declares the matching
    // capability. Without this, resolveModelId() always falls through to
    // catalog defaults — meaning user-picked t2i/i2i selections silently
    // revert on the next render. (See PR-3* assembly model picker bug.)
    if (direct.length > 0 || (group !== 't2i' && group !== 'i2i')) {
        return onlyAllowedModels(direct);
    }
    const capability = group; // 't2i' | 'i2i'
    return onlyAllowedModels(
        SORTED_MODEL_ENTRIES.filter(
            (model) =>
                model.ui.selection_group === 'image' &&
                model.capabilities.includes(capability) &&
                isVisibleModel(model, surface)
        )
    );
}

function toSelectableModel(model: CatalogModel): SelectableModelOption {
    return {
        id: model.id,
        name: model.display_name,
        description: model.description,
        badges: model.ui.badges ?? [],
        recommended: !!model.ui.recommended,
        family: model.family,
        status: model.status,
    };
}

function toI2VModel(model: CatalogModel): I2VModelConfig {
    return {
        id: model.id,
        name: model.display_name,
        description: model.description,
        duration: model.duration ?? { type: 'fixed', value: 5 },
        params: model.params ?? {},
        badges: model.ui.badges ?? [],
        recommended: !!model.ui.recommended,
        family: model.family,
        status: model.status,
    };
}

function getConfiguredDefaultId(group: SelectionGroup): string {
    if (group === 'text') {
        return (MODEL_CATALOG.defaults.model_settings as Record<string, string>).text_model;
    }
    if (group === 't2i') {
        return MODEL_CATALOG.defaults.model_settings.t2i_model;
    }
    if (group === 'i2i') {
        return MODEL_CATALOG.defaults.model_settings.i2i_model;
    }
    if (group === 'image') {
        return MODEL_CATALOG.defaults.model_settings.image_model;
    }
    if (group === 'r2v') {
        return (MODEL_CATALOG.defaults.model_settings as Record<string, string>).r2v_model
            ?? MODEL_CATALOG.defaults.model_settings.i2v_model;
    }
    return MODEL_CATALOG.defaults.model_settings.i2v_model;
}

function getFallbackVisibleModelId(group: SelectionGroup, surface: VisibilitySurface): string {
    const visibleModels = getVisibleModels(group, surface);
    // 本安装只接韭菜盒子网关，R2V 默认就用用户实际在跑的那个模型，
    // 而不是目录默认值（happyhorse-1.1-r2v 已被白名单滤掉，会让默认值漂移）。
    const configuredDefaultId =
        group === 'r2v' && visibleModels.some((model) => model.id === PREFERRED_R2V_MODEL_ID)
            ? PREFERRED_R2V_MODEL_ID
            : getConfiguredDefaultId(group);

    if (visibleModels.some((model) => model.id === configuredDefaultId)) {
        return configuredDefaultId;
    }

    return visibleModels[0]?.id ?? configuredDefaultId;
}

function warnModelFallback(
    group: SelectionGroup,
    requestedId: string,
    surface: VisibilitySurface,
    fallbackId: string
): void {
    console.warn(
        `[model_catalog] Falling back ${group} model "${requestedId}" to "${fallbackId}" for ${surface}.`
    );
}

function normalizeRequestedModelId(requestedId: string | null | undefined): string | undefined {
    if (!requestedId) {
        return undefined;
    }

    return CANONICAL_MODEL_ID_ALIASES[requestedId] ?? requestedId;
}

/** 早期版本往项目设置里写过带家族前缀的 id（jiucaihezi/dola-seedance2.5），
 *  目录里的真实 key 不带前缀。这里剥掉前缀换成真实 key，避免它被当成未知模型。
 *  ponytail: 只做前缀剥离，不做全量数据迁移；下次保存项目设置就会写回标准 id。 */
function toCatalogModelId(requestedId: string): string | undefined {
    if (MODEL_CATALOG.models[requestedId]) {
        return requestedId;
    }
    const stripped = requestedId.split('/').pop();
    return stripped && MODEL_CATALOG.models[stripped] ? stripped : undefined;
}

export function resolveModelId(
    group: SelectionGroup,
    requestedId: string | null | undefined,
    surface: VisibilitySurface
): string {
    const visibleModels = getVisibleModels(group, surface);
    const normalizedRequestedId = normalizeRequestedModelId(requestedId);

    if (normalizedRequestedId && visibleModels.some((model) => model.id === normalizedRequestedId)) {
        return normalizedRequestedId;
    }

    // 白名单内、但不属于当前分组的模型要原样保留。实例：项目里把 r2v 的
    // dola-seedance2.5 存进了 i2v_model —— 走分组兜底会被换成别家模型
    // （happyhorse-1.1-i2v），而那份密钥没配，生成必定 401。
    const requestedCatalogId = normalizedRequestedId ? toCatalogModelId(normalizedRequestedId) : undefined;
    const requestedModel = requestedCatalogId ? MODEL_CATALOG.models[requestedCatalogId] : undefined;
    if (
        requestedModel &&
        onlyAllowedModels([requestedModel]).length > 0 &&
        !['deprecated', 'hidden', 'planned'].includes(requestedModel.status)
    ) {
        return requestedCatalogId as string;
    }

    const fallbackId = getFallbackVisibleModelId(group, surface);
    if (requestedId && normalizedRequestedId !== fallbackId) {
        warnModelFallback(group, requestedId, surface, fallbackId);
    }
    return fallbackId;
}

export function resolveModelSettings(
    settings?: Partial<FrontendModelSettings> | null,
    surface: SettingsSurface = 'project_settings'
): FrontendModelSettings {
    return {
        ...DEFAULT_MODEL_SETTINGS,
        ...settings,
        t2i_model: resolveModelId('t2i', settings?.t2i_model, surface),
        i2i_model: resolveModelId('i2i', settings?.i2i_model, surface),
        image_model: resolveModelId('image', settings?.image_model, surface),
        i2v_model: resolveModelId('i2v', settings?.i2v_model, surface),
        r2v_model: resolveModelId('r2v', settings?.r2v_model, surface),
        text_model: resolveModelId('text', settings?.text_model, surface),
        character_aspect_ratio:
            settings?.character_aspect_ratio || DEFAULT_MODEL_SETTINGS.character_aspect_ratio,
        scene_aspect_ratio:
            settings?.scene_aspect_ratio || DEFAULT_MODEL_SETTINGS.scene_aspect_ratio,
        prop_aspect_ratio:
            settings?.prop_aspect_ratio || DEFAULT_MODEL_SETTINGS.prop_aspect_ratio,
        storyboard_aspect_ratio:
            settings?.storyboard_aspect_ratio || DEFAULT_MODEL_SETTINGS.storyboard_aspect_ratio,
    };
}

export const normalizeModelSettings = resolveModelSettings;
export const normalizeModelId = resolveModelId;

export function getMaxReferenceImages(modelId?: string | null): number {
    const resolvedModelId = resolveModelId('i2i', modelId, 'project_settings');
    const maxReferenceImages =
        MODEL_CATALOG.models[resolvedModelId]?.inputs?.reference_images?.max;

    return typeof maxReferenceImages === 'number' ? maxReferenceImages : 3;
}

// getVisibleModels() 已按允许家族过滤，所以这些选择器不需要再包一层。
export const PROJECT_T2I_MODELS = getVisibleModels('t2i', 'project_settings').map(toSelectableModel);
export const SERIES_T2I_MODELS = getVisibleModels('t2i', 'series_settings').map(toSelectableModel);
export const GLOBAL_T2I_MODELS = getVisibleModels('t2i', 'global_settings').map(toSelectableModel);

export const PROJECT_I2I_MODELS = getVisibleModels('i2i', 'project_settings').map(toSelectableModel);
export const SERIES_I2I_MODELS = getVisibleModels('i2i', 'series_settings').map(toSelectableModel);
export const GLOBAL_I2I_MODELS = getVisibleModels('i2i', 'global_settings').map(toSelectableModel);

export const PROJECT_IMAGE_MODELS = getVisibleModels('image', 'project_settings').map(toSelectableModel);
export const SERIES_IMAGE_MODELS = getVisibleModels('image', 'series_settings').map(toSelectableModel);
export const GLOBAL_IMAGE_MODELS = getVisibleModels('image', 'global_settings').map(toSelectableModel);

export const PROJECT_I2V_MODELS = getVisibleModels('i2v', 'project_settings').map(toI2VModel);
export const SERIES_I2V_MODELS = getVisibleModels('i2v', 'series_settings').map(toI2VModel);
export const GLOBAL_I2V_MODELS = getVisibleModels('i2v', 'global_settings').map(toI2VModel);
export const GLOBAL_R2V_MODELS = getVisibleModels('r2v', 'global_settings').map(toI2VModel);
export const GLOBAL_TEXT_MODELS = getVisibleModels('text', 'global_settings').map(toSelectableModel);
export const VIDEO_I2V_MODELS = getVisibleModels('i2v', 'video_sidebar').map(toI2VModel);

export const T2I_MODELS = PROJECT_T2I_MODELS;
export const I2I_MODELS = PROJECT_I2I_MODELS;
export const IMAGE_MODELS = PROJECT_IMAGE_MODELS;
export const I2V_MODELS = PROJECT_I2V_MODELS;
export const VIDEO_SIDEBAR_I2V_MODELS = VIDEO_I2V_MODELS;

export const DEFAULT_I2V_MODEL_ID = resolveModelId('i2v', undefined, 'video_sidebar');

// Default R2V selection/route follow the catalog meta default
// (defaults.model_settings.r2v_model) via getFallbackVisibleModelId, NOT raw
// ui.order: several R2V models share order=80, so an order-based pick would
// tie-break arbitrarily and silently drift when the catalog gains or renames a
// model. Default routing is a production concern, so anchor it to the explicit
// meta default (getFallbackVisibleModelId honors the configured default first,
// falling back to the highest-ordered visible R2V model only if that default is
// somehow not visible).
export const R2V_SELECTION_MODEL_ID = getFallbackVisibleModelId('r2v', 'video_sidebar');
export const R2V_ROUTE_MODEL_ID = R2V_SELECTION_MODEL_ID;

export function isR2vSelectionModel(modelId: string): boolean {
    return modelId === R2V_SELECTION_MODEL_ID;
}

// ---------------------------------------------------------------------------
// Dynamic R2V routing: resolve the hidden R2V model per-family
// ---------------------------------------------------------------------------

/** Map from family name to R2V route model ID. */
const R2V_ROUTE_MAP: Record<string, string> = {};
for (const model of SORTED_MODEL_ENTRIES) {
    if (model.capabilities.includes('r2v') && model.ui.selection_group === 'r2v') {
        if (!R2V_ROUTE_MAP[model.family]) {
            R2V_ROUTE_MAP[model.family] = model.id;
        }
    }
}

export const VIDEO_R2V_MODELS: I2VModelConfig[] = onlyAllowedModels(
    SORTED_MODEL_ENTRIES.filter((model) => model.ui.selection_group === 'r2v' && isVisibleModel(model, 'video_sidebar'))
).map(toI2VModel);
// 默认取 PREFERRED_R2V_MODEL_ID（不是列表首个 —— 列表按 ui.order 排，会漂到 minimax）。
export const DEFAULT_R2V_MODEL_ID =
    VIDEO_R2V_MODELS.find((model) => model.id === PREFERRED_R2V_MODEL_ID)?.id
    ?? VIDEO_R2V_MODELS[0]?.id
    ?? R2V_SELECTION_MODEL_ID;

/**
 * Given the currently selected I2V model, resolve the correct R2V route model.
 * Each family has its own hidden R2V model (e.g. wan -> wan2.6-r2v, happyhorse -> happyhorse-1.0-r2v).
 */
export function getR2vRouteModelId(selectedI2vModelId: string): string {
    const selectedModel = MODEL_CATALOG.models[selectedI2vModelId];
    if (!selectedModel) return R2V_ROUTE_MODEL_ID;
    return R2V_ROUTE_MAP[selectedModel.family] ?? R2V_ROUTE_MODEL_ID;
}

/**
 * Returns true if the given R2V model uses image references
 * instead of video references (Wan 2.5/2.6 legacy).
 */
export function isR2vImageBased(modelId: string): boolean {
    const model = MODEL_CATALOG.models[modelId];
    const family = model?.family;
    if (family === 'wan' && modelId === 'wan2.6-r2v') return false;
    return family === 'happyhorse' || family === 'wan' || family === 'kling'
        || family === 'pixverse' || family === 'vidu' || family === 'seedance' || family === 'jiucaihezi';
}
