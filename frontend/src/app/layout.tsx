import "./globals.css";
import EnvConfigChecker from "@/components/EnvConfigChecker";
import { Providers } from "@/components/Providers";
import { publicAsset } from "@/lib/publicAsset";

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh" className="atelier-light" suppressHydrationWarning>
      <head>
        <title>One OK Studio</title>
        <meta name="description" content="漫剧制作，一个就够。" />
        <link rel="icon" href={publicAsset("/1ok-logo-preview.svg")} type="image/svg+xml" />
        {/* 首屏防闪：html 的 class 要跟 DEFAULT_THEME 一致（否则先按旧主题画一帧，
            内联脚本/Providers 再改，会看到一下颜色跳变）。这里两处 fallback 都要跟着改。 */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var P=["atelier-dark","bridge-dark","brand-dark","atelier-light","brand-light"];var d=JSON.parse(localStorage.getItem("1okstudio-settings")||"{}");var t=d.state&&d.state.theme;document.documentElement.className=P.indexOf(t)>=0?t:"atelier-light";}catch(e){document.documentElement.className="atelier-light";}})();`,
          }}
        />
        {/* Desktop app: compact font-size for embedded windows (Tauri / pywebview).
            Detection covers: Tauri protocol, Tauri global, pywebview global,
            and the production static/index.html served by backend (pywebview). */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){var p=window.location.protocol;var h=window.location.hostname;var isTauri=p==='tauri:'||window.__TAURI__||window.__TAURI_INTERNALS__||h==='tauri.localhost';var isPywebview=!!window.pywebview||(p==='http:'&&(h==='127.0.0.1'||h==='localhost')&&window.location.pathname.indexOf('/static/')===0);if(isTauri||isPywebview){document.documentElement.style.fontSize='81.25%';}})();`,
          }}
        />
      </head>
      <body className="font-sans bg-background text-foreground antialiased">
        <Providers>
          <EnvConfigChecker />
          {children}
        </Providers>
      </body>
    </html>
  );
}
