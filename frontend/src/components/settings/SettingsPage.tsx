"use client";

import { useState, useEffect, useCallback, useRef, type ReactNode } from "react";
import { Save, Loader2, WifiOff, Copy, Check, Upload, ExternalLink } from "lucide-react";
import { useTranslations } from "next-intl";
import { api, getGlobalTextModel, setGlobalTextModel, type EnvConfigPayload, API_URL } from "@/lib/api";
import type { SkillPackageSummary } from "@/lib/api";
import SkillPicker, { skillNameFor } from "@/components/shared/SkillPicker";
import { ASPECT_RATIOS } from "@/store/projectStore";
import {
  DEFAULT_MODEL_SETTINGS,
  GLOBAL_I2V_MODELS,
  GLOBAL_R2V_MODELS,
  GLOBAL_IMAGE_MODELS,
  GLOBAL_TEXT_MODELS,
  normalizeModelSettings,
  type FrontendModelSettings,
} from "@/lib/modelCatalog";
import { useSettingsStore, type Locale, type ThemePreset } from "@/store/settingsStore";
import { toast } from "@/store/toastStore";
import { rovingKeyDown } from "@/lib/a11y";
import { Image, Video, Layout, User, Building, Box } from "lucide-react";
import GroupedModelGrid from "@/components/common/GroupedModelGrid";
import OneOkBranding from "@/components/layout/OneOkBranding";
import UpdateChecker from "./UpdateChecker";
type SettingsCategory = "general" | "models" | "prompts" | "apikeys" | "about";
import {
  FormRow,
  FieldLabel,
  KeyField,
  Toggle,
  ModeSegment,
  settingsInputClass,
} from "./SettingsControls";
import { APP_VERSION, APP_BUILD_DATE } from "@/lib/version";

type EnvConfig = EnvConfigPayload & {
  JIUCAIHEZI_API_KEY: string;
  endpoint_overrides: Record<string, string>;
};

const DEFAULT_CONFIG: EnvConfig = {
  JIUCAIHEZI_API_KEY: "",
  endpoint_overrides: {},
};

const normalizeEnvConfig = (existing: EnvConfig, data?: EnvConfigPayload): EnvConfig => ({
  ...existing,
  ...data,
  endpoint_overrides: data?.endpoint_overrides ?? existing.endpoint_overrides ?? {},
});

const getValidationErrors = (env: EnvConfig): string[] => {
  const errors: string[] = [];
  if (!env.JIUCAIHEZI_API_KEY?.trim()) errors.push("韭菜盒子 API Key");
  return errors;
};

const LS_KEY_MODEL = "1okstudio_default_model_settings";
const LS_KEY_PROMPT = "1okstudio_default_prompt_config";

interface DefaultPromptConfig {
  storyboard_polish: string;
  video_polish: string;
  r2v_polish: string;
  entity_extraction: string;
  style_analysis: string;
  storyboard_extraction: string;
  r2v_minimax: string;
  character_prompt: string;
  scene_prompt: string;
  prop_prompt: string;
  audio_plan: string;
  voice_prompt: string;
}

const EMPTY_PROMPT_CONFIG: DefaultPromptConfig = {
  storyboard_polish: "",
  video_polish: "",
  r2v_polish: "",
  entity_extraction: "",
  style_analysis: "",
  storyboard_extraction: "",
  r2v_minimax: "",
  character_prompt: "",
  scene_prompt: "",
  prop_prompt: "",
  audio_plan: "",
  voice_prompt: "",
};

function loadFromLS<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = localStorage.getItem(key);
    return raw ? { ...fallback, ...JSON.parse(raw) } : fallback;
  } catch {
    return fallback;
  }
}

// `name` / `desc` hold i18n keys (relative to the `settings` namespace) so the
// module-scope list can be resolved with t(...) at render time.
const THEME_OPTIONS: { id: ThemePreset; name: string; desc: string; base: string; primary: string; accent: string }[] = [
  { id: "atelier-dark",  name: "themeAtelierDark",  desc: "themeAtelierDarkDesc",  base: "#0c0b0e", primary: "#34d8c4", accent: "#ffa94d" },
  { id: "bridge-dark",   name: "themeBridgeDark",   desc: "themeBridgeDarkDesc",   base: "#0a0a0d", primary: "#646cff", accent: "#ffa94d" },
  { id: "brand-dark",    name: "themeBrandDark",    desc: "themeBrandDarkDesc",    base: "#050508", primary: "#646cff", accent: "#ff0080" },
  { id: "atelier-light", name: "themeAtelierLight", desc: "themeAtelierLightDesc", base: "#f6f1e9", primary: "#1d9c8d", accent: "#e8852b" },
  { id: "brand-light",   name: "themeBrandLight",   desc: "themeBrandLightDesc",   base: "#f8f9fa", primary: "#646cff", accent: "#ff0080" },
];

interface SystemReport {
  ffmpeg?: { available: boolean; message: string; path: string | null };
  status?: string;
}

/* Atelier section panel — restored per Line B mockup `.panel` (translucent
   warm-graphite card via glass-panel + atelier-card: surface + blur + soft
   shadow + hairline border, so sections read as distinct grouped cards).
   The page <header> stays frameless (mockup .main-head has no bg); only the
   content sections are carded. Model cards / inputs keep their own surfaces. */
function Section({
  id,
  title,
  desc,
  children,
}: {
  id?: string;
  title: string;
  desc?: string;
  children: ReactNode;
}) {
  return (
    <section
      id={id}
      aria-labelledby={id ? `${id}-title` : undefined}
      className="glass-panel atelier-card rounded-[20px] overflow-hidden"
    >
      <div className="atelier-card-head px-[22px] pt-[18px] pb-3.5 border-b border-glass-border">
        <h2
          id={id ? `${id}-title` : undefined}
          className="font-display atelier-display text-[1.1875rem] font-semibold text-foreground tracking-tight"
        >
          {title}
        </h2>
        {desc && <p className="text-[0.75rem] text-text-secondary mt-1 leading-relaxed">{desc}</p>}
      </div>
      <div className="px-[22px] pt-[18px] pb-[22px]">{children}</div>
    </section>
  );
}

export default function SettingsPage() {
  const t = useTranslations("settings");
  const { locale, theme, animations, setLocale, setTheme, setAnimations } = useSettingsStore();

  const [active, setActive] = useState<SettingsCategory>("general");

  // ── API Config ──
  const [config, setConfig] = useState<EnvConfig>(DEFAULT_CONFIG);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  // ── Default Model Settings ──
  const [modelSettings, setModelSettings] = useState<FrontendModelSettings>(() =>
    normalizeModelSettings(loadFromLS(LS_KEY_MODEL, DEFAULT_MODEL_SETTINGS), "global_settings")
  );

  // ── 全局文本模型 ──
  // 文本模型的真值在后端 `output/settings.json`，**不在** localStorage：
  // 它不按项目/系列存，这里选一次就对所有项目生效。
  const [globalTextModel, setGlobalTextModelState] = useState<string>(DEFAULT_MODEL_SETTINGS.text_model);
  const [textModelSaving, setTextModelSaving] = useState(false);

  useEffect(() => {
    getGlobalTextModel().then(setGlobalTextModelState).catch(() => undefined);
  }, []);

  // ── Default Prompt Config ──
  // `promptConfig` is the displayed/editable text. localStorage (LS_KEY_PROMPT)
  // only ever stores DELTAS: an empty value means "use the built-in default".
  // `promptDefaults` holds the real built-in defaults fetched from the backend
  // so we can pre-fill the fields and run the delta comparison on save.
  const [promptConfig, setPromptConfig] = useState<DefaultPromptConfig>(() =>
    loadFromLS(LS_KEY_PROMPT, EMPTY_PROMPT_CONFIG)
  );
  const [promptSkillBindings, setPromptSkillBindings] = useState<Record<string, string>>(() =>
    loadFromLS<{ skill_bindings?: Record<string, string> }>(LS_KEY_PROMPT, {}).skill_bindings || {}
  );
  const [promptDefaults, setPromptDefaults] = useState<Record<string, string>>({});
  // 可选 Skill：内置（随包）+ 已上传。拿不到就不阻断设置页，只剩“上传”可用。
  const [skillPackages, setSkillPackages] = useState<SkillPackageSummary[]>([]);

  useEffect(() => {
    api.listSkillPackages()
      .then(setSkillPackages)
      .catch((error) => {
        console.warn("Failed to list skill packages:", error);
        setSkillPackages([]);
      });
  }, []);

  // ── About / system ──
  const [online, setOnline] = useState(true);
  const [dataDir, setDataDir] = useState<string>("");
  const [logDir, setLogDir] = useState<string>("");
  const [system, setSystem] = useState<SystemReport | null>(null);
  const [systemLoading, setSystemLoading] = useState(false);
  const [systemChecked, setSystemChecked] = useState(false);
  const [copiedPath, setCopiedPath] = useState<string | null>(null);

  const loadConfig = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const data = await api.getEnvConfig();
      setConfig((prev) => normalizeEnvConfig(prev, data));
    } catch {
      setLoadError(t("loadConfigFailed"));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadConfig();
  }, [loadConfig]);

  // Pre-fill the prompt fields with the real built-in defaults so users can see
  // and edit from them. We remember the fetched defaults for the delta-save
  // comparison, and only fill a field the user has NOT overridden (empty in LS).
  // If the fetch fails we leave the fields empty (placeholder) — no crash.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const defaults = await api.fetchPromptDefaults();
        if (cancelled || !defaults) return;
        setPromptDefaults(defaults);
        setPromptConfig((prev) => {
          const next = { ...prev };
          (Object.keys(EMPTY_PROMPT_CONFIG) as (keyof DefaultPromptConfig)[]).forEach((k) => {
            const d = defaults[k];
            if (typeof d === "string" && d && !prev[k]) next[k] = d;
          });
          return next;
        });
      } catch {
        /* defaults unavailable — fields fall back to empty placeholders */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Online/offline detection for the banner.
  useEffect(() => {
    const update = () => setOnline(typeof navigator === "undefined" ? true : navigator.onLine);
    update();
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);

  // Pull health (data/log dir) once on mount so About + Storage can show paths.
  useEffect(() => {
    (async () => {
      try {
        const h = await api.healthCheck();
        if (h.log_dir) setLogDir(h.log_dir);
        if (h.log_file) {
          // data dir = parent of logs dir (logs lives under <data>/logs)
          const dir = h.log_dir.replace(/\/logs\/?$/, "");
          setDataDir(dir || h.log_dir);
        }
      } catch {
        /* backend offline — About shows fallback */
      }
    })();
  }, []);

  const loadSystem = useCallback(async () => {
    setSystemLoading(true);
    try {
      const r = await api.checkSystem();
      setSystem({ ffmpeg: r.dependencies?.ffmpeg, status: r.status });
      // Lock only on success so a recovered backend is reflected without
      // forcing a manual retry, while a successful read won't re-run.
      setSystemChecked(true);
    } catch {
      setSystem(null);
      // Leave systemChecked=false: re-entering the About tab retries once.
    } finally {
      setSystemLoading(false);
    }
  }, []);

  // Self-healing lazy load: auto-run the system check when the About tab
  // becomes active and we don't yet have a successful result. Driven off a
  // tab-transition ref so it fires once per entry (no render thrash) and is
  // not retried endlessly while the result is missing.
  const prevActiveRef = useRef<SettingsCategory | null>(null);
  useEffect(() => {
    const enteredAbout = active === "about" && prevActiveRef.current !== "about";
    prevActiveRef.current = active;
    if (active === "about" && !systemChecked && !systemLoading && enteredAbout) {
      loadSystem();
    }
  }, [active, systemChecked, systemLoading, loadSystem]);

  const handleSaveApiConfig = async () => {
    const errors = getValidationErrors(config);
    if (errors.length > 0) {
      toast.error(t("fillRequired"), { body: `- ${errors.join("\n- ")}` });
      return;
    }
    setSaving(true);
    try {
      await api.saveEnvConfig(config);
      toast.success(t("saveSuccess"));
    } catch {
      toast.error(t("saveConfigFailed"));
    } finally {
      setSaving(false);
    }
  };

  const handleChange = (key: keyof EnvConfig, value: string) => {
    setConfig((prev) => ({ ...prev, [key]: value }));
  };

  const revealApiKey = async () => {
    try { return await api.getEnvKey(); } catch { return undefined; }
  };

  const openJiucaiheziKeys = async () => {
    try { await api.openJiucaiheziKeys(); }
    catch { toast.error("无法打开获取页面"); }
  };

  // 文本模型：点击即写后端，不等「保存默认值」那个按钮 —— 那一个按钮存的是
  // 新建项目时用的图片/视频模型默认值（localStorage），跟文本模型不是一回事。
  const handleSelectTextModel = async (id: string) => {
    const previous = globalTextModel;
    setGlobalTextModelState(id);
    setTextModelSaving(true);
    try {
      setGlobalTextModelState(await setGlobalTextModel(id));
      toast.success(t("saved"));
    } catch {
      setGlobalTextModelState(previous);
      toast.error(t("saveConfigFailed"));
    } finally {
      setTextModelSaving(false);
    }
  };

  const handleSaveModelDefaults = () => {
    const normalized = normalizeModelSettings(modelSettings, "global_settings");
    // T2I and I2I share one image model in the UI; persist both backend
    // fields plus image_model so per-project backfill stays consistent.
    // ponytail: `text_model` 确实还留在这份 blob 里，但已经没人读 —— 后端只在
    // output/settings.json 取文本模型。留着是为了不动 FrontendModelSettings 的类型，
    // 要清理就连类型一起删。
    const merged: FrontendModelSettings = {
      ...normalized,
      i2i_model: normalized.t2i_model,
      image_model: normalized.t2i_model,
    };
    localStorage.setItem(LS_KEY_MODEL, JSON.stringify(merged));
    setModelSettings(merged);
    toast.success(t("saved"));
  };

  const handleSavePromptDefaults = () => {
    // DELTA persistence: a field equal to its built-in default is stored as ""
    // (=> use built-in, no snapshot pinning); only genuine overrides are saved.
    const delta: DefaultPromptConfig = { ...EMPTY_PROMPT_CONFIG };
    (Object.keys(EMPTY_PROMPT_CONFIG) as (keyof DefaultPromptConfig)[]).forEach((k) => {
      const text = promptConfig[k] ?? "";
      delta[k] = text === promptDefaults[k] ? "" : text;
    });
    localStorage.setItem(LS_KEY_PROMPT, JSON.stringify({ ...delta, skill_bindings: promptSkillBindings }));
    toast.success(t("saved"));
  };

  const copyPath = async (p: string) => {
    if (!p) return;
    try {
      await navigator.clipboard.writeText(p);
      setCopiedPath(p);
      setTimeout(() => setCopiedPath(null), 1200);
    } catch {
      /* clipboard blocked */
    }
  };

  /* ── Section renderers ──────────────────────────────────────── */

  const renderGeneral = () => (
    <Section id="general" title={t("secGeneralTitle")}>
      <FormRow label={t("language")} hint={t("languageDesc")}>
        <FieldLabel>LANGUAGE</FieldLabel>
        <ModeSegment
          value={locale}
          onChange={(v) => setLocale(v as Locale)}
          options={[
            { id: "zh", label: t("chinese") },
            { id: "en", label: t("english") },
          ]}
        />
      </FormRow>

      <FormRow label={t("theme")} hint={t("themeDesc")}>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2" role="radiogroup" aria-label={t("theme")} onKeyDown={rovingKeyDown}>
          {THEME_OPTIONS.map((preset) => (
            <button
              key={preset.id}
              type="button"
              role="radio"
              aria-checked={theme === preset.id}
              tabIndex={theme === preset.id ? 0 : -1}
              onClick={() => setTheme(preset.id)}
              className={`group relative flex flex-col gap-2 p-3 rounded-xl border text-left transition-all ${
                theme === preset.id
                  ? "border-primary/60 bg-primary/10 ring-1 ring-primary/30"
                  : "border-glass-border bg-hover-bg hover:border-text-muted"
              }`}
            >
              <div
                className="h-10 w-full rounded-lg border border-glass-border overflow-hidden flex items-end p-1.5 gap-1"
                style={{ background: preset.base }}
              >
                <span className="h-3 w-3 rounded-full" style={{ background: preset.primary }} />
                <span className="h-3 w-3 rounded-full" style={{ background: preset.accent }} />
              </div>
              <div className="min-w-0">
                <div className="text-xs font-medium text-foreground truncate">{t(preset.name)}</div>
                <div className="text-[0.625rem] text-text-muted truncate">{t(preset.desc)}</div>
              </div>
              {theme === preset.id && (
                <span className="absolute top-2 right-2 h-2 w-2 rounded-full bg-primary" />
              )}
            </button>
          ))}
        </div>
      </FormRow>

      <FormRow label={t("motionLabel")} hint={t("motionHint")}>
        <Toggle
          checked={animations}
          onChange={setAnimations}
          label={animations ? t("motionOn") : t("motionReduced")}
          sub={t("motionSub")}
          ariaLabel={t("motionToggleAria")}
        />
      </FormRow>
    </Section>
  );

  const aspectButtons = (key: keyof FrontendModelSettings) => (
    <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label={t("aspectRatioAria")} onKeyDown={rovingKeyDown}>
      {ASPECT_RATIOS.map((ratio) => (
        <button
          key={ratio.id}
          type="button"
          role="radio"
          aria-checked={modelSettings[key] === ratio.id}
          tabIndex={modelSettings[key] === ratio.id ? 0 : -1}
          onClick={() => setModelSettings((s) => ({ ...s, [key]: ratio.id }))}
          className={`flex flex-col items-center py-2 px-2 rounded-lg border transition-all ${
            modelSettings[key] === ratio.id
              ? "border-primary/50 bg-primary/10"
              : "border-glass-border hover:border-text-muted bg-glass"
          }`}
        >
          <span className="text-xs font-medium text-foreground">{ratio.name}</span>
        </button>
      ))}
    </div>
  );

  /** 全局文本模型选择器 —— 「模型」与「默认 Prompt」两页共用这一份渲染。
   *
   *  两页读的是同一个 state（globalTextModel）、用的是同一个 handler
   *  （handleSelectTextModel，点击即 PUT /settings/text_model），所以在一页改、
   *  另一页立刻跟着变 —— 不需要任何额外的同步逻辑。
   */
  const renderGlobalTextModelRow = () => (
    <FormRow label="全局文本模型" hint="用于剧本分析、实体提取、提示词生成与润色；全局一个，所有项目共用">
      <GroupedModelGrid
        models={GLOBAL_TEXT_MODELS}
        selectedId={globalTextModel}
        onSelect={handleSelectTextModel}
      />
      {textModelSaving && (
        <p className="mt-2 flex items-center gap-1 text-xs text-text-muted">
          <Loader2 size={12} className="animate-spin" />
          {t("saving")}
        </p>
      )}
    </FormRow>
  );

  const renderModels = () => (
    <Section
      id="models"
      title={t("secModelsTitle")}
      desc={t("secModelsDesc")}
    >
      {/* 全局文本模型：后端单源，点击即写、立即对全项目生效。 */}
      {renderGlobalTextModelRow()}

      {/* Image model (T2I + I2I unified) */}
      <FormRow label={t("imageModelLabel")} hint={t("imageModelHint")}>
        <div className="flex items-center gap-2 text-sm font-semibold text-foreground mb-3">
          <Image size={15} className="text-emerald-400" />
          <span>{t("imageModelCaption")}</span>
        </div>
        <GroupedModelGrid
          models={GLOBAL_IMAGE_MODELS}
          selectedId={modelSettings.t2i_model}
          onSelect={(id) => setModelSettings((s) => ({ ...s, t2i_model: id, i2i_model: id, image_model: id }))}
        />
      </FormRow>

      {/* Asset aspect ratios */}
      <FormRow label={t("assetAspectLabel")} hint={t("assetAspectHint")}>
        <div className="grid grid-cols-3 gap-4">
          {(
            [
              { key: "character_aspect_ratio" as const, label: t("assetCharacter"), icon: User },
              { key: "scene_aspect_ratio" as const, label: t("assetScene"), icon: Building },
              { key: "prop_aspect_ratio" as const, label: t("assetProp"), icon: Box },
            ] as const
          ).map(({ key, label, icon: Icon }) => (
            <div key={key} className="space-y-2">
              <div className="flex items-center gap-1 text-xs text-text-secondary">
                <Icon size={12} />
                <label>{label}</label>
              </div>
              <div className="space-y-1">
                {ASPECT_RATIOS.map((ratio) => (
                  <button
                    key={ratio.id}
                    type="button"
                    onClick={() => setModelSettings((s) => ({ ...s, [key]: ratio.id }))}
                    className={`w-full flex flex-col items-center py-2 px-2 rounded border transition-all ${
                      modelSettings[key] === ratio.id
                        ? "border-emerald-500/50 bg-emerald-500/10"
                        : "border-glass-border hover:border-text-muted bg-glass"
                    }`}
                  >
                    <span className="text-xs font-medium text-foreground">{ratio.name}</span>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      </FormRow>

      {/* Storyboard aspect ratio */}
      <FormRow label={t("storyboardAspectLabel")} hint={t("storyboardAspectHint")}>
        <div className="flex items-center gap-2 text-sm font-semibold text-foreground mb-3">
          <Layout size={15} className="text-primary" />
          <span>Storyboard Aspect Ratio</span>
        </div>
        {aspectButtons("storyboard_aspect_ratio")}
      </FormRow>

      {/* I2V */}
      <FormRow label={t("i2vModelLabel")} hint={t("i2vModelHint")}>
        <div className="flex items-center gap-2 text-sm font-semibold text-foreground mb-3">
          <Video size={15} className="text-purple-400" />
          <span>Image-to-Video</span>
        </div>
        <GroupedModelGrid
          models={GLOBAL_I2V_MODELS}
          selectedId={modelSettings.i2v_model}
          onSelect={(id) => setModelSettings((s) => ({ ...s, i2v_model: id }))}
        />
      </FormRow>

      {/* R2V */}
      <FormRow label={t("r2vModelLabel")} hint={t("r2vModelHint")}>
        <div className="flex items-center gap-2 text-sm font-semibold text-foreground mb-3">
          <Video size={15} className="text-purple-400" />
          <span>Reference-to-Video</span>
        </div>
        <GroupedModelGrid
          models={GLOBAL_R2V_MODELS}
          selectedId={modelSettings.r2v_model ?? ""}
          onSelect={(id) => setModelSettings((s) => ({ ...s, r2v_model: id }))}
        />
      </FormRow>

      <div className="flex justify-end pt-4">
        <button
          type="button"
          onClick={handleSaveModelDefaults}
          className="flex items-center gap-2 px-4 py-2 bg-primary hover:bg-primary-hover text-on-accent text-sm font-medium rounded-lg transition-all"
        >
          <Save size={16} />
          {t("saveDefaults")}
        </button>
      </div>
    </Section>
  );

  const PROMPT_FIELDS: { key: keyof DefaultPromptConfig; label: string; desc: string }[] = [
    { key: "entity_extraction", label: t("promptEntityLabel"), desc: t("promptEntityDesc") },
    { key: "style_analysis", label: t("promptStyleLabel"), desc: t("promptStyleDesc") },
    { key: "storyboard_extraction", label: t("promptStoryboardExtractLabel"), desc: t("promptStoryboardExtractDesc") },
    { key: "storyboard_polish", label: t("promptStoryboardPolishLabel"), desc: t("promptStoryboardPolishDesc") },
    { key: "video_polish", label: t("promptVideoPolishLabel"), desc: t("promptVideoPolishDesc") },
    { key: "r2v_polish", label: t("promptR2vPolishLabel"), desc: t("promptR2vPolishDesc") },
    { key: "r2v_minimax", label: "MiniMax R2V Skill", desc: "MiniMax 参考生视频专用规则。" },
    { key: "character_prompt", label: "角色资产 Skill", desc: "基于角色描述与项目风格生成角色提示词。" },
    { key: "scene_prompt", label: "场景资产 Skill", desc: "基于场景描述与项目风格生成场景提示词。" },
    { key: "prop_prompt", label: "道具资产 Skill", desc: "基于道具描述与项目风格生成道具提示词。" },
    { key: "audio_plan", label: "全局导演声音稿 Skill", desc: "声音步骤里「生成导演稿」用的 Skill；产出直接喂给 seed-audio-1.0。" },
    { key: "voice_prompt", label: "角色参考音设计 Skill", desc: "角色工作台「声音→生成提示词」用的 Skill；产出喂给 CosyVoice 音色设计。" },
  ];

  const renderPrompts = () => (
    <>
      {/* 模型放最上面：提示词和模型是配套的，一个决定“怎么写”、一个决定“谁来写”。
          和「模型」页共用同一个选择器，在任一边改都会同步。 */}
      <Section
        id="prompts-model"
        title="文本模型"
        desc="选定后全应用通用：剧本分析、实体提取、提示词生成与润色都用它。与「模型」页是同一个开关，改哪边都一样。"
      >
        {renderGlobalTextModelRow()}
      </Section>

      <Section
        id="prompts"
        title={t("secPromptsTitle")}
        desc={t("secPromptsDesc")}
      >
      <div className="space-y-5">
        {PROMPT_FIELDS.map((f) => (
          <div key={f.key} className="space-y-2">
            <div className="flex items-center justify-between gap-2"><h3 className="text-sm font-semibold text-foreground">{f.label}</h3><div className="flex items-center gap-1 shrink-0"><SkillPicker packages={skillPackages} onSelect={(id) => setPromptSkillBindings(prev => ({ ...prev, [f.key]: id }))} /><label className="cursor-pointer text-xs text-primary whitespace-nowrap"><Upload size={12} className="mr-1 inline" />上传 Skill 包<input type="file" accept=".zip,.md,.markdown,.txt" className="hidden" onChange={async (e) => { const file = e.target.files?.[0]; if (!file) return; try { const pkg = await api.uploadSkillPackage(file); setPromptSkillBindings(prev => ({ ...prev, [f.key]: pkg.id })); setSkillPackages(prev => [...prev, { ...pkg, builtin: false, source_name: pkg.name } as SkillPackageSummary]); } catch (error: any) { toast.error(error?.response?.data?.detail || 'Skill 包上传失败'); } }} /></label></div></div>
            <p className="text-[0.6875rem] text-text-muted">{f.desc}</p>
            {promptSkillBindings[f.key] && <div className="flex items-center justify-between"><p className="text-[0.625rem] text-emerald-400">已绑定：{skillNameFor(promptSkillBindings[f.key], skillPackages)}</p><button type="button" onClick={() => setPromptSkillBindings(prev => { const next = { ...prev }; delete next[f.key]; return next; })} className="text-[0.625rem] text-text-muted hover:text-foreground">解除绑定</button></div>}
            <textarea
              value={promptConfig[f.key]}
              onChange={(e) => setPromptConfig((prev) => ({ ...prev, [f.key]: e.target.value }))}
              placeholder={t("promptPlaceholder")}
              className="w-full h-32 bg-input-bg border border-glass-border rounded-lg p-3 text-xs text-foreground resize-y focus:outline-none focus:border-primary/50 font-mono placeholder-text-muted"
            />
          </div>
        ))}
      </div>
      <div className="flex justify-end pt-4">
        <button
          type="button"
          onClick={handleSavePromptDefaults}
          className="flex items-center gap-2 px-4 py-2 bg-primary hover:bg-primary-hover text-on-accent text-sm font-medium rounded-lg transition-colors"
        >
          <Save size={16} />
          {t("saveDefaults")}
        </button>
      </div>
    </Section>
    </>
  );

  const renderApiKeys = () => (
    <Section
      id="apikeys"
      title={t("secApiTitle")}
      desc={t("secApiDesc")}
    >
      {loading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 size={24} className="animate-spin text-primary" />
          <span className="ml-2 text-text-secondary">{t("loadingConfig")}</span>
        </div>
      ) : loadError ? (
        <div className="bg-status-failed-bg border border-status-failed-border rounded-lg p-4 text-sm text-status-failed-fg">
          {loadError}
        </div>
      ) : (
        <div className="space-y-1">
          <FormRow label="韭菜盒子 API Key">
            <FieldLabel>JIUCAIHEZI_API_KEY *</FieldLabel>
            <KeyField
              value={config.JIUCAIHEZI_API_KEY}
              onChange={(v) => handleChange("JIUCAIHEZI_API_KEY", v)}
              placeholder="API Key"
              onReveal={revealApiKey}
            />
          </FormRow>

          <div className="flex justify-end items-center gap-2 pt-4">
            <button type="button" onClick={openJiucaiheziKeys} className="inline-flex items-center gap-2 px-4 py-2 border border-glass-border text-text-secondary hover:text-foreground text-sm font-medium rounded-lg transition-all">
              <ExternalLink size={15} /> 前往获取
            </button>
            <button
              type="button"
              onClick={handleSaveApiConfig}
              disabled={saving || loading || !online}
              className="flex items-center gap-2 px-4 py-2 bg-primary hover:bg-primary-hover text-on-accent text-sm font-medium rounded-lg transition-all disabled:opacity-50"
            >
              {saving ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />}
              {saving ? t("saving") : t("saveConfig")}
            </button>
          </div>
        </div>
      )}
    </Section>
  );

  const renderAbout = () => {
    const ff = system?.ffmpeg;
    const aboutRows: { k: string; v: string; tone?: "ok" | "warn" }[] = [
      { k: t("aboutAppVersion"), v: `One OK Studio ${APP_VERSION}` },
      { k: t("aboutBackendApi"), v: API_URL },
      { k: t("aboutDataDir"), v: dataDir || "—" },
      { k: t("logDirLabel"), v: logDir || "—" },
    ];
    return (
      <Section id="about" title={t("secAboutTitle")}>
        {/* Line B brand signature block — teal-glow logo, serif name, amber tagline */}
        <div className="flex flex-col items-start gap-3 pb-6 mb-6 border-b border-glass-border">
          <OneOkBranding size="md" showSlogan={false} />
          <p className="font-display atelier-display text-base italic text-accent leading-snug">
            “Render Noise into Narrative”
          </p>
          <div className="font-mono text-[0.625rem] tracking-[0.08em] text-text-muted uppercase">
            VERSION {APP_VERSION.replace(/^v/, "")} · BUILD {APP_BUILD_DATE}
          </div>
          <p className="text-[0.78125rem] text-text-secondary leading-relaxed max-w-md">
            {t("aboutTagline")}
          </p>
        </div>

        {/* Check for updates — compares APP_VERSION against latest GitHub release */}
        <div className="mb-6">
          <UpdateChecker />
        </div>

        {/* Technical info table */}
        <div className="font-mono text-[0.59375rem] uppercase tracking-[0.1em] text-text-muted mb-3">
          {t("aboutTechInfo")}
        </div>
        <div className="space-y-0">
          {aboutRows.map((r) => (
            <div key={r.k} className="flex justify-between items-center py-2.5 border-b border-glass-border last:border-b-0 text-[0.78125rem] gap-3">
              <span className="text-text-secondary shrink-0">{r.k}</span>
              <span className="font-mono text-[0.71875rem] text-foreground truncate text-right">{r.v}</span>
            </div>
          ))}
          {/* FFmpeg row with live detection */}
          <div className="flex justify-between items-center py-2.5 border-b border-glass-border last:border-b-0 text-[0.78125rem] gap-3">
            <span className="text-text-secondary shrink-0">FFmpeg</span>
            <span className="font-mono text-[0.71875rem] text-right truncate">
              {systemLoading ? (
                <span className="inline-flex items-center gap-1.5 text-text-muted">
                  <Loader2 size={12} className="animate-spin" /> {t("ffmpegChecking")}
                </span>
              ) : ff ? (
                ff.available ? (
                  <span className="text-emerald-400" title={ff.message}>{t("ffmpegAvailable")}</span>
                ) : (
                  <span className="text-amber-400" title={ff.message}>{t("ffmpegMissing")}</span>
                )
              ) : (
                <span className="text-text-muted">{t("ffmpegUnknown")}</span>
              )}
            </span>
          </div>
        </div>
        <div className="flex justify-end pt-4">
          <button
            type="button"
            onClick={loadSystem}
            disabled={systemLoading}
            className="flex items-center gap-2 px-3 py-1.5 text-xs rounded-md border border-glass-border bg-surface text-text-secondary hover:text-foreground transition-colors disabled:opacity-50"
          >
            {systemLoading ? <Loader2 size={13} className="animate-spin" /> : <Copy size={13} />}
            {t("recheck")}
          </button>
        </div>
      </Section>
    );
  };

  const renderActive = () => {
    switch (active) {
      case "general":
        return renderGeneral();
      case "models":
        return renderModels();
      case "prompts":
        return renderPrompts();
      case "apikeys":
        return renderApiKeys();
      case "about":
        return renderAbout();
      default:
        return null;
    }
  };

  const CATEGORY_TITLE: Record<SettingsCategory, string> = {
    general: t("eyebrowGeneral"),
    models: t("eyebrowModels"),
    prompts: t("eyebrowPrompts"),
    apikeys: t("eyebrowApikeys"),
    about: t("eyebrowAbout"),
  };

  // 横向 Tab 短标签（取代竖向 SettingsSidebar；与全局品牌侧栏轴向正交，不再撞脸）。
  const TABS: { id: SettingsCategory; label: string }[] = [
    { id: "general", label: t("tabGeneral") },
    { id: "models", label: t("tabModels") },
    { id: "prompts", label: t("eyebrowPrompts") },
    { id: "apikeys", label: t("eyebrowApikeys") },
    { id: "about", label: t("eyebrowAbout") },
  ];

  return (
    <div className="relative h-full flex flex-col">
      {/* Atelier signature layers — inert on non-atelier themes. */}
      <div className="atelier-page-bloom" aria-hidden="true" />
      <div className="atelier-page-grain" aria-hidden="true" />

      {/* Head: eyebrow(当前分类) + 「设置」标题 + 横向 Tab —— 取代竖向子栏 */}
      <header className="flex-shrink-0 border-b border-glass-border px-4 md:px-7 pt-6 pb-4 relative z-10">
        <div className="w-full">
        <div className="font-mono text-[0.625rem] font-medium uppercase tracking-[0.2em] text-text-muted">
          SETTINGS · <span className="text-primary font-semibold">{CATEGORY_TITLE[active]}</span>
        </div>
        <h1 className="font-display atelier-display text-[1.625rem] md:text-[2.125rem] font-semibold text-foreground mt-2 tracking-tight">
          {t("title")}
        </h1>
        <nav className="flex flex-wrap gap-1 mt-5" role="tablist" aria-label={t("tabsAria")} onKeyDown={rovingKeyDown}>
          {TABS.map((tab) => {
            const isActive = active === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={isActive}
                tabIndex={isActive ? 0 : -1}
                onClick={() => setActive(tab.id)}
                className={`px-3.5 py-1.5 rounded-full text-[0.8125rem] transition-colors ${
                  isActive
                    ? "bg-primary/10 text-foreground font-semibold"
                    : "text-text-muted hover:text-foreground hover:bg-hover-bg font-medium"
                }`}
              >
                {tab.label}
              </button>
            );
          })}
        </nav>
        </div>
      </header>

      {/* Scroll area */}
      <div className="flex-1 overflow-y-auto px-10 py-8 relative z-10">
        <div className="max-w-6xl mx-auto flex flex-col gap-6">
          {!online && (
            <div
              role="status"
              className="flex items-center gap-3 px-4 py-3 rounded-lg bg-status-processing-bg border border-status-processing-border"
            >
              <WifiOff size={18} className="text-status-processing-fg flex-shrink-0" />
              <div className="flex-1">
                <div className="text-[0.78125rem] font-semibold text-foreground">{t("offlineTitle")}</div>
                <div className="text-[0.6875rem] text-text-secondary mt-0.5">
                  {t("offlineBody")}
                </div>
              </div>
            </div>
          )}

          {renderActive()}
          <div className="pb-8" />
        </div>
      </div>
    </div>
  );
}
