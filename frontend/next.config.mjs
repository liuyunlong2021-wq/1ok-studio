/** @type {import('next').NextConfig} */
import { readFileSync } from 'node:fs';

const isProd = process.env.NODE_ENV === 'production';
const isDocker = process.env.DOCKER_BUILD === 'true';
const isTauri = process.env.TAURI_BUILD === 'true';

const BACKEND_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:17177';

// 版本号的唯一来源。界面上显示的那份（src/lib/version.ts）和打包产物那份
// （src-tauri/tauri.conf.json）都从 package.json 跟过来，别再往组件里写死值。
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
// YYYYMMDD，跟设置页「VERSION x.y.z · BUILD yyyymmdd」的格式对应。
const BUILD_DATE = new Date().toISOString().slice(0, 10).replace(/-/g, '');

// Tauri build: output to frontend/out/ with no basePath (loaded via Tauri protocol)
// Docker build: output to frontend/out/
// Default prod: output to ../static/ with /static basePath
//
// 这个前缀只对 Next 自己产出的资源（页面、_next chunk、next/image）生效。
// public/ 里手写的 `src="/foo.png"` 不会被自动加前缀 —— 桌面 APP 加载的正是
// 这份构建，于是那些 URL 全部 404（Windows 端 logo 一直是破图的根因）。
// 前端要引用 public/ 资源时统一走 lib/publicAsset.ts。
const BASE_PATH = isProd && !isDocker && !isTauri ? '/static' : '';

const nextConfig = {
    // 编译期内联给客户端，静态导出也生效。
    env: {
        NEXT_PUBLIC_APP_VERSION: `v${pkg.version}`,
        NEXT_PUBLIC_BUILD_DATE: BUILD_DATE,
        NEXT_PUBLIC_BASE_PATH: BASE_PATH,
    },
    output: isProd ? 'export' : undefined,
    distDir: isProd ? (isTauri ? 'out' : (isDocker ? 'out' : '../static')) : undefined,
    basePath: BASE_PATH || undefined,
    assetPrefix: BASE_PATH || undefined,
    // Dev-only: proxy /api-proxy/* to backend to avoid CORS issues (e.g. file downloads)
    async rewrites() {
        return isProd ? [] : [
            {
                source: '/api-proxy/:path*',
                destination: `${BACKEND_URL}/:path*`,
            },
        ];
    },
    eslint: {
        ignoreDuringBuilds: true,
    },
    typescript: {
        ignoreBuildErrors: true,
    },
    images: {
        unoptimized: true,
        remotePatterns: [
            {
                protocol: "https",
                hostname: "placehold.co",
            },
            {
                protocol: "http",
                hostname: "localhost",
                port: "17177",
            },
        ],
    },
};

export default nextConfig;
