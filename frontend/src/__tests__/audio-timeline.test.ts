/**
 * 全集声音的时间轴刻度。
 *
 * 音频纯粹给人听，程序不做任何切分。UI 只需要把「到这里是 30 秒」画出来
 * （视频模型单次上限 30 秒），剩下的交给耳朵。
 */
import { describe, expect, it } from 'vitest';

import { DEFAULT_STEP_MS, buildThirtySecondMarks, formatClock } from '@/lib/audioTimeline';

const labels = (durationMs: number) =>
    buildThirtySecondMarks(durationMs).map((mark) => mark.label);

describe('全集声音的时间轴刻度', () => {
    it('95 秒 → 0:00 / 0:30 / 1:00 / 1:30 四个刻度', () => {
        expect(labels(95_000)).toEqual(['0:00', '0:30', '1:00', '1:30']);
    });

    it('刻度不超出音频时长', () => {
        for (const mark of buildThirtySecondMarks(95_000)) {
            expect(mark.ms).toBeLessThanOrEqual(95_000);
        }
    });

    it('恰好 30 秒 → 0:00 和 0:30 两个刻度', () => {
        expect(labels(30_000)).toEqual(['0:00', '0:30']);
    });

    it('不足 30 秒 → 只有 0:00', () => {
        expect(labels(12_000)).toEqual(['0:00']);
    });

    it('时长为 0 / 非数字 / 负数 → 空数组，不画刻度', () => {
        expect(buildThirtySecondMarks(0)).toEqual([]);
        expect(buildThirtySecondMarks(Number.NaN)).toEqual([]);
        expect(buildThirtySecondMarks(-1)).toEqual([]);
    });

    it('formatClock(95000) === "1:35"，秒数补零', () => {
        expect(formatClock(95_000)).toBe('1:35');
        expect(formatClock(5_000)).toBe('0:05');
        expect(formatClock(3_600_000)).toBe('60:00');
    });

    it('默认刻度间隔是视频模型的单次上限 30 秒', () => {
        expect(DEFAULT_STEP_MS).toBe(30_000);
    });
});
