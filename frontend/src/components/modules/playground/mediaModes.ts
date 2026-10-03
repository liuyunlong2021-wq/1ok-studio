import type { PlaygroundMode } from './usePlaygroundStore';

// ---------------------------------------------------------------------------
// 每种模式对「输入素材」的约束。
//
// MediaInput 的渲染（标签 / accept / 上限）与 useResultAsReference 的
// 「追加还是替换」判定共用这一份，避免两处规则漂移。
// ---------------------------------------------------------------------------

export interface ModeConfig {
  labelKey: string;
  accept: string;
  hintKey: string;
  multiple: boolean;
  maxFiles: number;
  icon: 'image' | 'video' | 'audio';
}

export const MODE_CONFIG: Partial<Record<PlaygroundMode, ModeConfig>> = {
  t2i: {
    labelKey: 'media.labelReferenceOptional',
    accept: 'image/*',
    hintKey: 't2i',
    multiple: true,
    maxFiles: 9,
    icon: 'image',
  },
  i2i: {
    labelKey: 'compose.mediaReference',
    accept: 'image/*',
    hintKey: 'i2i',
    multiple: false,
    maxFiles: 1,
    icon: 'image',
  },
  i2v: {
    labelKey: 'compose.mediaFirstFrame',
    accept: 'image/*',
    hintKey: 'i2v',
    multiple: false,
    maxFiles: 1,
    icon: 'image',
  },
  r2v: {
    labelKey: 'compose.mediaReference',
    accept: 'image/*',
    hintKey: 'r2v',
    multiple: true,
    maxFiles: 9,
    icon: 'image',
  },
  v2v: {
    labelKey: 'compose.mediaSourceVideo',
    accept: 'video/*',
    hintKey: 'v2v',
    multiple: false,
    maxFiles: 1,
    icon: 'video',
  },
  r2a: { labelKey: 'compose.mediaReferenceAudio', accept: 'audio/*', hintKey: 'r2a', multiple: true, maxFiles: 3, icon: 'audio' },
};

/** Share the model's reference limit and single/multiple behavior across input paths. */
export function getMediaInputConfig(mode: PlaygroundMode, modelReferenceLimit?: number): ModeConfig | undefined {
  const config = MODE_CONFIG[mode];
  if (!config || !['t2i', 'i2i', 'r2v'].includes(mode)) return config;
  const maxFiles = modelReferenceLimit ?? config.maxFiles;
  return { ...config, maxFiles, multiple: maxFiles > 1 };
}

/**
 * 把一批新引用收进输入区，返回新的引用数组。
 *
 * 规则（本地文件上传、从资产库选取、截帧三处共用同一份）：
 * - 已在里面的不重复加（同一张图加两次没有意义，只会白占配额）；
 * - 单参考配置（multiple=false）**替换**唯一那张，后选的胜出；
 * - 多参考模式**追加到末尾**，超上限的丢掉（调用方负责先拦，别让用户白选）；
 * - 什么都收不下时原样返回（**同一个数组引用**，调用方据此判断"没变化就别 setState"）。
 *
 * 变量名里的「引用」= inputMedia：交给后端的媒体引用（相对 output/）。
 */
export function mergeReferences(
  current: string[],
  incoming: string[],
  config: Pick<ModeConfig, 'multiple' | 'maxFiles'>,
): string[] {
  const fresh = incoming.filter((p) => p && !current.includes(p));
  if (fresh.length === 0) return current;

  // 单参考模式：不追加，只替换 —— 追加会多出一张界面看不见、但照样送进生成的图。
  if (!config.multiple) return [fresh[fresh.length - 1]];

  const room = config.maxFiles - current.length;
  if (room <= 0) return current;
  return [...current, ...fresh.slice(0, room)];
}
