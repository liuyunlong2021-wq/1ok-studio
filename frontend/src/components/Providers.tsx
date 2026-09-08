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

    if (initialized && (!isDesktop || backendReady)) return children;

    return (
        <main className="grid h-screen w-screen place-items-center bg-background text-foreground">
            <div className="text-center">
                <p className="font-medium">{backendError || "正在启动服务…"}</p>
                {backendError && (
                    <button className="mt-4 rounded-lg bg-primary px-4 py-2 text-on-accent" onClick={retry}>
                        重试
                    </button>
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
