import { describe, expect, it } from 'vitest';
import { publicAsset } from '@/lib/publicAsset';

/**
 * public/ 资源路径的护栏。
 *
 * 桌面 APP 加载的是默认生产构建（basePath = /static），Next **不会**给手写的
 * `src="/foo.png"` 加这个前缀，于是 logo / favicon / 模板示例图在 Windows 端
 * 全是 404 —— 界面里就是破图。这组用例锁住"必须自己加前缀"这条契约。
 */
describe('publicAsset', () => {
    it('带 /static 前缀的生产构建里补上前缀', () => {
        expect(publicAsset('/1ok-logo-preview.svg', '/static')).toBe('/static/1ok-logo-preview.svg');
        expect(publicAsset('/assets/templates/design-sheet.png', '/static')).toBe(
            '/static/assets/templates/design-sheet.png',
        );
    });

    it('dev / Tauri 构建没有前缀时原样返回，不多出一个斜杠', () => {
        expect(publicAsset('/1ok-logo-preview.svg', '')).toBe('/1ok-logo-preview.svg');
    });

    it('非绝对路径不动（外链、data URL、后端媒体路径都不归它管）', () => {
        expect(publicAsset('https://example.com/a.png', '/static')).toBe('https://example.com/a.png');
        expect(publicAsset('output/assets/x.png', '/static')).toBe('output/assets/x.png');
    });

    it('默认参数取构建期注入的 NEXT_PUBLIC_BASE_PATH（测试环境未设 → 无前缀）', () => {
        expect(publicAsset('/1ok-logo-preview.svg')).toBe('/1ok-logo-preview.svg');
    });
});
