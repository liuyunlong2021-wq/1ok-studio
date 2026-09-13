/**
 * 尺寸表自检：这张表是「唯一的尺寸事实源」，打错一个数字就会变成生成时才报错，
 * 所以这里把规格里写的硬约束全部验一遍。
 *
 * 顺带守住「4K 不是 1K × 4」这条：4K 有最大单边/最大总像素限制，各比例上限不同。
 */

import { describe, expect, it } from 'vitest';
import {
  ASPECT_RATIO_PRESETS,
  CUSTOM_SIZE_RULES,
  IMAGE_SIZE_PRESETS,
  RESOLUTIONS,
  parseImageSize,
  presetRatioForSize,
  presetResolutionForSize,
  resolvePresetSize,
  sizeToRatioLabel,
  validateCustomSize,
} from '@/lib/imageSizePresets';

const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));

describe('IMAGE_SIZE_PRESETS', () => {
  it('每个分辨率都覆盖全部预设比例', () => {
    for (const resolution of RESOLUTIONS) {
      expect(Object.keys(IMAGE_SIZE_PRESETS[resolution]).sort()).toEqual(
        [...ASPECT_RATIO_PRESETS].sort(),
      );
    }
  });

  it('每个尺寸都满足倍数、单边、总像素约束，且比例与标签一致', () => {
    for (const resolution of RESOLUTIONS) {
      for (const ratio of ASPECT_RATIO_PRESETS) {
        const parsed = parseImageSize(IMAGE_SIZE_PRESETS[resolution][ratio]);
        expect(parsed, `${resolution} ${ratio} 无法解析`).not.toBeNull();
        const { width, height } = parsed!;
        const where = `${resolution} ${ratio} ${width}x${height}`;

        expect(width % CUSTOM_SIZE_RULES.multipleOf, `${where} 宽不是 16 的倍数`).toBe(0);
        expect(height % CUSTOM_SIZE_RULES.multipleOf, `${where} 高不是 16 的倍数`).toBe(0);
        expect(Math.max(width, height), `${where} 超过单边上限`).toBeLessThanOrEqual(
          CUSTOM_SIZE_RULES.maxSide,
        );
        const pixels = width * height;
        expect(pixels, `${where} 总像素过低`).toBeGreaterThanOrEqual(CUSTOM_SIZE_RULES.minPixels);
        expect(pixels, `${where} 总像素过高`).toBeLessThanOrEqual(CUSTOM_SIZE_RULES.maxPixels);

        // 比例的**数值**必须与标签一致（注意不能比约分后的字符串：
        // 21:9 的像素 1344x576 约分后是 7:3，标签仍然是 21:9）
        const [labelW, labelH] = ratio.split(':').map(Number);
        expect(width / height, `${where} 与比例标签数值不符`).toBeCloseTo(labelW / labelH, 5);
        expect(gcd(width, height), `${where} 不是最简比`).toBe(
          gcd(labelW, labelH) * (width / labelW),
        );
      }
    }
  });

  it('4K 是按表取上限，不是 1K 的倍数放大', () => {
    // 按倍数放大会得到 4096x4096，上游不接受
    expect(IMAGE_SIZE_PRESETS['4K']['1:1']).toBe('2880x2880');
    expect(IMAGE_SIZE_PRESETS['4K']['21:9']).toBe('3808x1632');
    expect(IMAGE_SIZE_PRESETS['4K']['16:9']).toBe('3840x2160');
    // 3:1 顶着单边 3840，而 1:1 只能到 2880
    expect(IMAGE_SIZE_PRESETS['4K']['3:1']).toBe('3840x1280');
  });

  it('21:9 / 9:21 的像素不是最简比，所以标签必须由 UI 状态持有，不能从像素反推', () => {
    // 1344x576 约分是 7:3 —— 如果 UI 用 sizeToRatioLabel 反推，
    // 用户选了 21:9 却会显示成 7:3。
    expect(sizeToRatioLabel(resolvePresetSize('1K', '21:9'))).toBe('7:3');
    expect(sizeToRatioLabel(resolvePresetSize('1K', '16:9'))).toBe('16:9');
  });

  it('每个 size 字符串全局唯一，UI 才能靠反查驱动两个下拉', () => {
    const seen = new Map<string, string>();
    for (const resolution of RESOLUTIONS) {
      for (const ratio of ASPECT_RATIO_PRESETS) {
        const size = IMAGE_SIZE_PRESETS[resolution][ratio];
        expect(seen.has(size), `${size} 同时出现在 ${seen.get(size)} 与 ${resolution} ${ratio}`).toBe(
          false,
        );
        seen.set(size, `${resolution} ${ratio}`);
      }
    }
    expect(seen.size).toBe(RESOLUTIONS.length * ASPECT_RATIO_PRESETS.length);
  });

  it('反查能还原回原比例标签（含 21:9 这种非最简比）', () => {
    for (const resolution of RESOLUTIONS) {
      for (const ratio of ASPECT_RATIO_PRESETS) {
        const size = IMAGE_SIZE_PRESETS[resolution][ratio];
        expect(presetRatioForSize(size), `${size} 反查比例失败`).toBe(ratio);
        expect(presetResolutionForSize(size), `${size} 反查分辨率失败`).toBe(resolution);
      }
    }
    expect(presetRatioForSize('1344x576')).toBe('21:9');
    expect(presetRatioForSize('999x999')).toBe('自定义');
    expect(presetResolutionForSize('999x999')).toBeNull();
  });

  it('resolvePresetSize 返回可直接发 API 的 size 字符串', () => {
    expect(resolvePresetSize('4K', '21:9')).toMatchObject({
      width: 3808,
      height: 1632,
      size: '3808x1632',
    });
    expect(resolvePresetSize('1K', '16:9')?.size).toBe('1280x720');
  });
});

describe('validateCustomSize', () => {
  it('接受合法尺寸并规范化输出', () => {
    // 注意 1920x1080 其实非法：1080 不是 16 的倍数
    expect(validateCustomSize(1920, 1080).size).toBeNull();
    expect(validateCustomSize(1280, 720)).toMatchObject({ errors: [], size: '1280x720' });
  });

  it('拒绝非 16 倍数', () => {
    expect(validateCustomSize(1920, 1081).errors.length).toBeGreaterThan(0);
  });

  it('拒绝超出 1:3 ~ 3:1 的比例', () => {
    // 4:1 越界（尺寸本身合法：16 的倍数、3840 内、像素达标）
    expect(validateCustomSize(3840, 960).errors.join()).toContain('比例');
  });

  it('拒绝超过单边 3840', () => {
    expect(validateCustomSize(3904, 3904).errors.join()).toContain('3840');
  });

  it('拒绝总像素越界', () => {
    // 太小：480x480 = 230,400 < 655,360
    expect(validateCustomSize(480, 480).errors.join()).toContain('不得低于');
    // 太大：3840x2880 = 11,059,200 > 8,294,400
    expect(validateCustomSize(3840, 2880).errors.join()).toContain('不得超过');
  });

  it('非正整数直接拒绝', () => {
    expect(validateCustomSize(0, 1024).size).toBeNull();
    expect(validateCustomSize(1024.5, 1024).size).toBeNull();
  });
});
