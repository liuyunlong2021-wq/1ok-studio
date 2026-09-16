import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type Locale = 'zh' | 'en';

/**
 * 5 预设主题（Tasty Sam 主题系统）。
 * 3 暗（atelier-dark / bridge-dark / brand-dark）+ 2 亮（atelier-light 默认 / brand-light）。
 * 与 globals.css 的 html.<id> block、Providers/layout 切换逻辑一一对应。
 */
export type ThemePreset =
    | 'atelier-dark'
    | 'bridge-dark'
    | 'brand-dark'
    | 'atelier-light'
    | 'brand-light';

export const THEME_PRESETS: ThemePreset[] = [
    'atelier-dark',
    'bridge-dark',
    'brand-dark',
    'atelier-light',
    'brand-light',
];

export const DEFAULT_THEME: ThemePreset = 'atelier-light';

interface SettingsStore {
    locale: Locale;
    theme: ThemePreset;
    // 全局动效开关。true = 启用 motion（默认）；false = 降低动效，
    // 由 Providers 挂载 html.no-motion 类来落地（无障碍/性能偏好）。
    animations: boolean;
    setLocale: (locale: Locale) => void;
    setTheme: (theme: ThemePreset) => void;
    setAnimations: (animations: boolean) => void;
}

export const useSettingsStore = create<SettingsStore>()(
    persist(
        (set) => ({
            locale: 'zh',
            theme: DEFAULT_THEME,
            animations: true,
            setLocale: (locale: Locale) => set({ locale }),
            setTheme: (theme: ThemePreset) => set({ theme }),
            setAnimations: (animations: boolean) => set({ animations }),
        }),
        {
            name: '1okstudio-settings',
            version: 2,
            // v0→v1：旧版只有 'dark' | 'light' → 统一升级到新默认（不保留旧观感）。
            //        非法 / 缺失值同样回落默认。
            // v1→v2：默认主题从 atelier-dark 换成 atelier-light（暖陶白 · teal）。
            //        只迁移「停在旧默认 atelier-dark 上」的人 —— atelier-dark 正是那个
            //        旧默认，而主动选过别的主题的人不该被覆盖。
            migrate: (persisted: unknown, version: number) => {
                const state = (persisted ?? {}) as Partial<SettingsStore>;
                const animations = typeof state.animations === 'boolean' ? state.animations : true;
                const theme = state.theme as ThemePreset | undefined;
                if (version < 1 || !theme || !THEME_PRESETS.includes(theme)) {
                    return { ...state, theme: DEFAULT_THEME, animations } as SettingsStore;
                }
                if (version < 2 && theme === 'atelier-dark') {
                    return { ...state, theme: DEFAULT_THEME, animations } as SettingsStore;
                }
                return { ...state, animations } as SettingsStore;
            },
        }
    )
);
