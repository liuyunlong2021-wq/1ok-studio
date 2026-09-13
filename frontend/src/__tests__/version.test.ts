import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '..');
const FRONTEND = path.resolve(HERE, '../..');
const REPO = path.resolve(FRONTEND, '..');
const VERSION_MODULE = path.join(SRC, 'lib', 'version.ts');

/** 自己声明一份版本常量 —— 正是这次出问题的写法。 */
const OWN_VERSION_CONST = /(?:const|let|var)\s+APP_(?:VERSION|BUILD_DATE)\s*=/;
const SEMVER = /["'`]v?\d+\.\d+\.\d+["'`]/;

/** 去掉注释，免得说明文字里引用的版本号把守卫绊倒。 */
function stripComments(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

function sourceFiles(dir: string): string[] {
    return readdirSync(dir, { recursive: true, withFileTypes: true })
        .filter((e) => e.isFile() && /\.(ts|tsx)$/.test(e.name))
        .map((e) => path.join(e.parentPath, e.name));
}

describe('app version has exactly one source', () => {
    // 以前 SettingsPage / UpdateChecker / GlobalSidebar 各存了一份 "v1.0.1"，
    // manifest 走到 1.1.0 了界面还显示 1.0.1，「检查更新」也跟着判断错。
    it('nobody but lib/version.ts declares its own APP_VERSION', () => {
        const offenders = sourceFiles(SRC)
            .filter((f) => f !== VERSION_MODULE)
            .filter((f) => OWN_VERSION_CONST.test(stripComments(readFileSync(f, 'utf8'))))
            .map((f) => path.relative(REPO, f));

        expect(offenders, `版本号只能从 @/lib/version 取：\n${offenders.join('\n')}`)
            .toEqual([]);
    });

    it('lib/version.ts reads the injected env and keeps no release number', () => {
        const code = stripComments(readFileSync(VERSION_MODULE, 'utf8'));
        expect(code).toContain('process.env.NEXT_PUBLIC_APP_VERSION');
        expect(code).toContain('process.env.NEXT_PUBLIC_BUILD_DATE');
        // 兜底值必须一眼不是发布号，免得被拿去跟 GitHub tag 比。
        const literals = code.match(new RegExp(SEMVER, 'g')) ?? [];
        expect(literals.every((l) => l.includes('v0.0.0-dev'))).toBe(true);
    });

    it('next.config.mjs injects the version from package.json', () => {
        const config = readFileSync(path.join(FRONTEND, 'next.config.mjs'), 'utf8');
        expect(config).toContain('NEXT_PUBLIC_APP_VERSION');
        expect(config).toContain('NEXT_PUBLIC_BUILD_DATE');
        expect(config).toMatch(/package\.json/);
    });

    // 界面上显示的版本（package.json）和打包产物里的版本（tauri.conf.json）
    // 是两处手工维护的字段，bump 时漏一个就会「装的 1.1.0、界面写 1.0.1」。
    it('frontend/package.json and tauri.conf.json declare the same version', () => {
        const pkg = JSON.parse(readFileSync(path.join(FRONTEND, 'package.json'), 'utf8'));
        const tauri = JSON.parse(readFileSync(path.join(REPO, 'src-tauri/tauri.conf.json'), 'utf8'));
        expect(pkg.version).toBe(tauri.version);
    });
});
