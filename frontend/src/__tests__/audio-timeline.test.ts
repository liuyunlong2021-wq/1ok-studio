/**
 * 全集声音的时间轴刻度规格 —— **待实现**。
 *
 * 这一步的音频**纯粹给人听**，程序不做任何切分。UI 只要两样东西：
 * 波形（前端 decodeAudioData 现算，不落库）+ 30 秒刻度（视频模型单次上限）。
 *
 * 待实现 `@/lib/audioTimeline`：
 *
 *   buildThirtySecondMarks(durationMs: number, stepMs?: number): { ms: number; label: string }[]
 *   formatClock(ms: number): string     // "0:00" / "1:35"
 *
 * 纯函数，所以在 node 环境（vitest.config.mts）里就能测，不需要 jsdom。
 */
import { describe, it } from 'vitest';

describe('全集声音的时间轴刻度', () => {
    it.todo('95 秒 → 0:00 / 0:30 / 1:00 / 1:30 四个刻度');
    it.todo('刻度不超出音频时长（95 秒不会画出 2:00）');
    it.todo('恰好 30 秒 → 0:00 和 0:30 两个刻度');
    it.todo('不足 30 秒 → 只有 0:00');
    it.todo('时长为 0 / null / 负数 → 空数组，不画刻度');
    it.todo('formatClock(95000) === "1:35"，秒数补零');
});
