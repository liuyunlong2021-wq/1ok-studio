import { describe, expect, it } from 'vitest';
import { characterImageUrl, scenePropImageUrl } from '@/lib/characterImage';
import { errorMessage } from '@/lib/utils';

/**
 * 资产取图 & 错误提示的两条护栏。
 *
 * 两个都是"同一个东西被多处各写一份、其中一份漏了字段"踩出来的：
 *   · 取图漏了 `reference_sheet` → 有图的资产在某个 UI 里是空占位
 *   · 错误提示直接塞 `detail` → FastAPI 的 422 数组被渲染成 "[object Object]"
 */
describe('资产取图', () => {
    it('reference_sheet 里选中的那张优先（新生成的资产只写这里）', () => {
        const c = {
            reference_sheet: {
                selected_image_id: 'b',
                image_variants: [{ id: 'a', url: 'a.png' }, { id: 'b', url: 'b.png' }],
            },
        };

        expect(characterImageUrl(c as never)).toBe('b.png');
    });

    it('reference_sheet 有图但没选中时退回第一张，不显示空占位', () => {
        const c = { reference_sheet: { selected_image_id: null, image_variants: [{ id: 'a', url: 'a.png' }] } };

        expect(characterImageUrl(c as never)).toBe('a.png');
    });

    it('只有旧容器 full_body_asset（variants/selected_id）时也认', () => {
        const c = { full_body_asset: { selected_id: 'x', variants: [{ id: 'x', url: 'x.png' }] } };

        expect(characterImageUrl(c as never)).toBe('x.png');
    });

    it('没有任何图字段 → undefined', () => {
        expect(characterImageUrl({} as never)).toBeUndefined();
    });

    it('场景/道具：image_asset → legacy url', () => {
        const withAsset = { image_asset: { selected_id: 's', variants: [{ id: 's', url: 'scene.png' }] } };
        const legacyOnly = { image_url: 'legacy.png' };

        expect(scenePropImageUrl(withAsset as never)).toBe('scene.png');
        expect(scenePropImageUrl(legacyOnly)).toBe('legacy.png');
        expect(scenePropImageUrl(null)).toBeUndefined();
    });
});

describe('errorMessage', () => {
    it('字符串 detail 直接用', () => {
        expect(errorMessage({ response: { data: { detail: '资产正在被引用' } } })).toBe('资产正在被引用');
    });

    it('对象 detail 取 message', () => {
        const err = { response: { data: { detail: { error: 'library_asset_in_use', message: '被 2 处分镜引用' } } } };

        expect(errorMessage(err)).toBe('被 2 处分镜引用');
    });

    it('FastAPI 422 的数组 detail 不再渲染成 [object Object]', () => {
        const err = { response: { data: { detail: [{ loc: ['body', 'name'], msg: 'field required' }] } } };
        const message = errorMessage(err);

        expect(message).not.toBe('[object Object]');
        expect(message).toContain('field required');
    });

    it('Error 实例与兜底', () => {
        expect(errorMessage(new Error('boom'))).toBe('boom');
        expect(errorMessage(undefined, '删除资产失败')).toBe('删除资产失败');
    });
});
