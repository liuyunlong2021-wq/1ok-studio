"use client";

import { useState, useEffect } from "react";
import { useSettingsStore, type ThemePreset } from "@/store/settingsStore";

interface LumenXBrandingProps {
  size?: "sm" | "md";
  showSlogan?: boolean;
}

// 1OK 品牌标志按主题复用；SVG 自带深色底，适合当前深色工作台。
const LOGO_SRC: Record<ThemePreset, string> = {
  "atelier-dark": "/1ok-logo-preview.svg",
  "bridge-dark": "/1ok-logo-preview.svg",
  "brand-dark": "/1ok-logo-preview.svg",
  "atelier-light": "/1ok-logo-preview.svg",
  "brand-light": "/1ok-logo-preview.svg",
};

export default function LumenXBranding({ size = "md", showSlogan = true }: LumenXBrandingProps) {
  const logoSize = size === "sm" ? "w-9 h-9" : "w-14 h-14";
  const titleSize = size === "sm" ? "text-lg" : "text-xl";

  const theme = useSettingsStore((s) => s.theme);
  // SSR 与客户端首次渲染统一用默认主题，避免 logo src/filter 的 hydration
  // mismatch；挂载后切到实际主题。
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const activeTheme: ThemePreset = mounted ? theme : "atelier-dark";
  const logoSrc = LOGO_SRC[activeTheme] ?? "/1ok-logo-preview.svg";

  return (
    <div>
      <div className="flex gap-3 items-center">
        <div className="flex-shrink-0">
          <img
            src={logoSrc}
            alt="1 OK"
            className={`${logoSize} object-contain`}
          />
        </div>
        <div className="flex flex-col justify-center">
          <div className="flex items-baseline gap-0">
            <span className={`font-mono ${titleSize} font-bold tracking-tight text-foreground`}>
              1 OK
            </span>
          </div>
          {size !== "sm" && (
            <span className="font-mono text-[0.6875rem] text-text-muted tracking-[0.2em] uppercase -mt-0.5">
              漫剧制作
            </span>
          )}
        </div>
      </div>
      {showSlogan && (
        <p className="font-mono atelier-display text-[0.5rem] text-text-muted tracking-[0.15em] text-center mt-2.5 uppercase">
          漫剧制作，一个就够。
        </p>
      )}
    </div>
  );
}
