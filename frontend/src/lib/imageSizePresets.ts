/**
 * GPT Image 2.5 尺寸配置 —— 唯一的尺寸事实源。
 *
 * 用户只选「分辨率 + 画面比例」，真实像素尺寸从这里查表得到，最终以
 * `size: "WIDTHxHEIGHT"` 发给 API。不要把 `4K` / `21:9` 这类标签发给 API。
 *
 * 为什么 4K 不是「1K × 4」：GPT Image 2.5 有最大单边与最大总像素限制，所以每个
 * 比例在 4K 档的合法上限各不相同（1:1 只能到 2880×2880，21:9 只能到 3808×1632，
 * 16:9 才能到 3840×2160）。必须查表，不能按倍数放大。
 *
 * 换模型 / 加比例 / 改尺寸都只改这一份表。
 */

export const RESOLUTIONS = ['1K', '2K', '4K'] as const;
export type Resolution = (typeof RESOLUTIONS)[number];

/** 常用比例预设。自定义比例不走这里。 */
export const ASPECT_RATIO_PRESETS = [
  '1:1',
  '5:4',
  '4:5',
  '4:3',
  '3:4',
  '3:2',
  '2:3',
  '5:3',
  '3:5',
  '16:9',
  '9:16',
  '2:1',
  '1:2',
  '21:9',
  '9:21',
  '3:1',
  '1:3',
] as const;
export type AspectRatioPreset = (typeof ASPECT_RATIO_PRESETS)[number];

export const CUSTOM_RATIO = '自定义' as const;

const PRESETS: Record<Resolution, Record<AspectRatioPreset, string>> = {
  '1K': {
    '1:1': '1024x1024',
    '5:4': '960x768',
    '4:5': '768x960',
    '4:3': '1024x768',
    '3:4': '768x1024',
    '3:2': '1152x768',
    '2:3': '768x1152',
    '5:3': '1280x768',
    '3:5': '768x1280',
    '16:9': '1280x720',
    '9:16': '720x1280',
    '2:1': '1280x640',
    '1:2': '640x1280',
    '21:9': '1344x576',
    '9:21': '576x1344',
    '3:1': '1440x480',
    '1:3': '480x1440',
  },
  '2K': {
    '1:1': '2048x2048',
    '5:4': '1920x1536',
    '4:5': '1536x1920',
    '4:3': '2048x1536',
    '3:4': '1536x2048',
    '3:2': '2304x1536',
    '2:3': '1536x2304',
    '5:3': '2560x1536',
    '3:5': '1536x2560',
    '16:9': '2560x1440',
    '9:16': '1440x2560',
    '2:1': '2560x1280',
    '1:2': '1280x2560',
    '21:9': '2688x1152',
    '9:21': '1152x2688',
    '3:1': '2880x960',
    '1:3': '960x2880',
  },
  '4K': {
    '1:1': '2880x2880',
    '5:4': '3200x2560',
    '4:5': '2560x3200',
    '4:3': '3264x2448',
    '3:4': '2448x3264',
    '3:2': '3504x2336',
    '2:3': '2336x3504',
    '5:3': '3680x2208',
    '3:5': '2208x3680',
    '16:9': '3840x2160',
    '9:16': '2160x3840',
    '2:1': '3840x1920',
    '1:2': '1920x3840',
    '21:9': '3808x1632',
    '9:21': '1632x3808',
    '3:1': '3840x1280',
    '1:3': '1280x3840',
  },
};

/** 自定义尺寸的硬约束（与上游一致，超出会生成失败）。 */
export const CUSTOM_SIZE_RULES = {
  /** 宽高必须是 16 的倍数。 */
  multipleOf: 16,
  /** 单边上限。 */
  maxSide: 3840,
  /** 总像素下限 / 上限。 */
  minPixels: 655_360,
  maxPixels: 8_294_400,
  /** 比例范围 1:3 ~ 3:1。 */
  maxAspect: 3,
} as const;

/** `IMAGE_SIZE_PRESETS["4K"]["21:9"]` → `"3808x1632"` */
export const IMAGE_SIZE_PRESETS = PRESETS;

export interface ImageSize {
  width: number;
  height: number;
  /** 发给 API 的 `size` 值。 */
  size: string;
}

function toSize(text: string): ImageSize {
  const [width, height] = text.split('x').map((n) => parseInt(n, 10));
  return { width, height, size: text };
}

export function parseImageSize(size: string): ImageSize | null {
  const match = /^(\d+)[x*×](\d+)$/i.exec(size.trim());
  if (!match) return null;
  const width = parseInt(match[1], 10);
  const height = parseInt(match[2], 10);
  if (!width || !height) return null;
  return { width, height, size: `${width}x${height}` };
}

/** 常用比例查表。比例不在预设里请走 `validateCustomSize`。 */
export function resolvePresetSize(
  resolution: Resolution,
  ratio: AspectRatioPreset,
): ImageSize | null {
  const entry = PRESETS[resolution]?.[ratio];
  return entry ? toSize(entry) : null;
}

/**
 * 自定义尺寸校验。返回错误清单（空数组 = 合法）与规范化后的 size。
 *
 * 与预设表同样的限制，所以自定义不会绕过 4K 的像素上限。
 */
export function validateCustomSize(width: number, height: number): {
  errors: string[];
  size: string | null;
} {
  const errors: string[] = [];
  const { multipleOf, maxSide, minPixels, maxPixels, maxAspect } = CUSTOM_SIZE_RULES;

  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    return { errors: ['宽高必须是正整数'], size: null };
  }
  if (width % multipleOf !== 0 || height % multipleOf !== 0) {
    errors.push(`宽高必须是 ${multipleOf} 的倍数`);
  }
  if (width > maxSide || height > maxSide) {
    errors.push(`任意一边不得超过 ${maxSide}`);
  }
  const aspect = width / height;
  if (aspect > maxAspect || aspect < 1 / maxAspect) {
    errors.push(`比例需在 1:${maxAspect} ~ ${maxAspect}:1 之间`);
  }
  const pixels = width * height;
  if (pixels < minPixels) {
    errors.push(`总像素不得低于 ${minPixels.toLocaleString()}`);
  }
  if (pixels > maxPixels) {
    errors.push(
      `总像素不得超过 ${maxPixels.toLocaleString()}（该比例下更大的尺寸上游不接受）`,
    );
  }

  return { errors, size: errors.length ? null : `${width}x${height}` };
}

/**
 * 反查：像素属于哪个分辨率档。
 *
 * 表里每个 size 字符串全局唯一，所以这两个反查是确定的 —— UI 因此只需要维护
 * `size` 一个值，分辨率和比例都从它推出来，不用再存第二份状态。
 */
export function presetResolutionForSize(size: string | null): Resolution | null {
  if (!size) return null;
  for (const resolution of RESOLUTIONS) {
    for (const ratio of ASPECT_RATIO_PRESETS) {
      if (PRESETS[resolution][ratio] === size) return resolution;
    }
  }
  return null;
}

/**
 * 反查：像素对应表格里的哪个比例标签。
 *
 * 必须查表而不是约分像素：21:9 的像素是 1344x576，约分后成了 7:3，
 * 用户明明选的是 21:9，显示成 7:3 就是 bug。查不到才回落到 `CUSTOM_RATIO`。
 */
export function presetRatioForSize(size: string | null): AspectRatioPreset | typeof CUSTOM_RATIO {
  if (!size) return CUSTOM_RATIO;
  for (const resolution of RESOLUTIONS) {
    for (const ratio of ASPECT_RATIO_PRESETS) {
      if (PRESETS[resolution][ratio] === size) return ratio;
    }
  }
  return CUSTOM_RATIO;
}

/** 供 UI 显示「4K · 21:9」这类完整标签下的像素小字。 */
export function formatSizeLabel(size: ImageSize): string {
  return `${size.width} × ${size.height}`;
}

/** 把自定义像素还原成一个可读比例（约分后），用于列表回显。 */
export function sizeToRatioLabel(size: ImageSize | null): string | null {
  if (!size || !size.width || !size.height) return null;
  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
  const divisor = gcd(size.width, size.height);
  return `${size.width / divisor}:${size.height / divisor}`;
}
