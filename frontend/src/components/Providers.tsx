"use client";

import { useEffect, useState } from 'react';
import { NextIntlClientProvider } from 'next-intl';
import { useSettingsStore, THEME_PRESETS } from '@/store/settingsStore';
import { getMessages } from '@/lib/i18n';
import { LightboxProvider } from '@/components/shared/preview/LightboxProvider';
import ToastContainer from '@/components/shared/ToastContainer';
import { MotionConfig } from 'framer-motion';
import { useDesktopStore } from '@/store/desktopStore';

function BackendGate({ children }: { children: React.ReactNode }) {
    const [initialized, setInitialized] = useState(false);
    const isDesktop = useDesktopStore((s) => s.isDesktop);
    const backendReady = useDesktopStore((s) => s.backendReady);
    const backendError = useDesktopStore((s) => s.backendError);
    const init = useDesktopStore((s) => s.init);
    const retry = useDesktopStore((s) => s.startHealthCheck);

    useEffect(() => {
        init();
        setInitialized(true);
    }, [init]);

    useEffect(() => {
        // 开发期自愈：`.next` 被重建（换 dev server / 清缓存）之后，已经打开的窗口还
        // 拿着旧的 chunk 名，取不到就报 `ChunkLoadError: Loading chunk app/layout
        // failed`，而且自己不会恢复 —— 白白卡住一个窗口。
        // 这里自动重载一次。15 秒内只做一次，防止「重载完还是坏」时来回刷。
        if (process.env.NODE_ENV === 'production') return;
        const RELOAD_KEY = 'chunk-error-reload-at';
        const reloadOnce = () => {
            const last = Number(sessionStorage.getItem(RELOAD_KEY) || 0);
            if (Date.now() - last < 15_000) return;
            sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
            window.location.reload();
        };
        const onError = (event: ErrorEvent) => {
            if (/ChunkLoadError|Loading chunk .* failed/i.test(String(event?.message || ''))) reloadOnce();
        };
        const onRejection = (event: PromiseRejectionEvent) => {
            const reason = String((event?.reason as Error)?.message || event?.reason || '');
            if (/ChunkLoadError|Loading chunk .* failed/i.test(reason)) reloadOnce();
        };
        window.addEventListener('error', onError);
        window.addEventListener('unhandledrejection', onRejection);
        return () => {
            window.removeEventListener('error', onError);
            window.removeEventListener('unhandledrejection', onRejection);
        };
    }, []);

    if (initialized && (!isDesktop || backendReady)) return children;

    return (
        <main className="grid h-screen w-screen place-items-center bg-background text-foreground">
            <div className="text-center">
                <p className="font-medium">{backendError || "正在启动服务…"}</p>
                {backendError && (
                    <div className="mt-4 flex justify-center gap-2">
                        <button className="rounded-lg border border-border px-4 py-2" onClick={() => import('@tauri-apps/api/core').then(({ invoke }) => invoke('open_sidecar_log'))}>
                            打开启动日志
                        </button>
                        <button className="rounded-lg bg-primary px-4 py-2 text-on-accent" onClick={retry}>
                            重试
                        </button>
                    </div>
                )}
            </div>
        </main>
    );
}

export function Providers({ children }: { children: React.ReactNode }) {
    const locale = useSettingsStore((s) => s.locale);
    const theme = useSettingsStore((s) => s.theme);
    const animations = useSettingsStore((s) => s.animations);
    const messages = getMessages(locale);

    useEffect(() => {
        const html = document.documentElement;
        // 移除全部 5 个预设 class + 旧版遗留的 dark/light，再加当前主题
        html.classList.remove(...THEME_PRESETS, 'dark', 'light');
        html.classList.add(theme);
    }, [theme]);

    useEffect(() => {
        // animations=false → 挂 html.no-motion，CSS 据此降低/禁用过渡动画
        document.documentElement.classList.toggle('no-motion', !animations);
    }, [animations]);

    useEffect(() => {
        document.documentElement.lang = locale;
    }, [locale]);

    return (
        <NextIntlClientProvider locale={locale} messages={messages} timeZone="Asia/Shanghai">
            {/* MotionConfig: respect OS prefers-reduced-motion ("user"); when the
             *  in-app 动效 toggle is off, force-reduce Framer animations ("always"). */}
            <MotionConfig reducedMotion={animations ? "user" : "always"}>
                {/* LightboxProvider must wrap any subtree that uses PreviewImage /
                 *  PreviewVideo. Singleton portal — see Issue 14 design notes in
                 *  LightboxProvider.tsx. */}
                <LightboxProvider>
                    <BackendGate>{children}</BackendGate>
                    <ToastContainer />
                </LightboxProvider>
            </MotionConfig>
        </NextIntlClientProvider>
    );
}
