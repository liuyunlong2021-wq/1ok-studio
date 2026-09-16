/**
 * 全集声音的时间轴刻度。
 *
 * 音频纯粹给人听，程序不做任何切分。UI 要把时间说清楚：主刻度 30 秒（视频模型
 * 单次上限，就是「哪几个镜头能放一组」的判断线）、次刻度 10 秒（更细的参照）。
 */
import { describe, expect, it } from 'vitest';

import {
    DEFAULT_STEP_MS,
    SUB_STEP_MS,
    buildSubMarks,
    buildThirtySecondMarks,
    formatClock,
} from '@/lib/audioTimeline';

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

describe('次级刻度（10 秒）', () => {
    it('跳过与主刻度重合的位置，别在同一根位置画两次', () => {
        // 125 秒：10/20 · 40/50 · 70/80 · 100/110 —— 30/60/90/120 让给主刻度
        expect(buildSubMarks(125_000)).toEqual([
            10_000, 20_000, 40_000, 50_000, 70_000, 80_000, 100_000, 110_000,
        ]);
    });

    it('不超出音频时长', () => {
        expect(buildSubMarks(95_000)).toEqual([
            10_000, 20_000, 40_000, 50_000, 70_000, 80_000,
        ]);
    });

    it('时长不足 10 秒 / 未知 → 空数组', () => {
        expect(buildSubMarks(5_000)).toEqual([]);
        expect(buildSubMarks(0)).toEqual([]);
        expect(buildSubMarks(Number.NaN)).toEqual([]);
    });

    it('默认间隔是 10 秒', () => {
        expect(SUB_STEP_MS).toBe(10_000);
    });
});
