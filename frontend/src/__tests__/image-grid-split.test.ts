import { describe, expect, it } from 'vitest';
import { imageSplitRects, tileFilename } from '@/lib/imageGridSplit';

const area = (rects: { width: number; height: number }[]) => rects.reduce((s, r) => s + r.width * r.height, 0);

describe('imageSplitRects', () => {
    it('2048² 四宫格切成四张 1024²', () => {
        expect(imageSplitRects(2048, 2048, { cols: 2, rows: 2 })).toEqual([
            { index: 1, x: 0, y: 0, width: 1024, height: 1024 },
            { index: 2, x: 1024, y: 0, width: 1024, height: 1024 },
            { index: 3, x: 0, y: 1024, width: 1024, height: 1024 },
            { index: 4, x: 1024, y: 1024, width: 1024, height: 1024 },
        ]);
    });

    it('除不尽的尺寸不留缝、不重叠', () => {
        for (const [w, h] of [[2047, 2048], [1633, 2913], [999, 1001]]) {
            for (const grid of [{ cols: 2, rows: 2 }, { cols: 3, rows: 3 }, { cols: 1, rows: 2 }]) {
                expect(area(imageSplitRects(w, h, grid))).toBe(w * h);
            }
        }
    });

    it('非法尺寸或网格返回空', () => {
        expect(imageSplitRects(0, 100, { cols: 2, rows: 2 })).toEqual([]);
        expect(imageSplitRects(100, 100, { cols: 0, rows: 2 })).toEqual([]);
    });

    it('文件名带格子序号', () => {
        expect(tileFilename('a.webp', 3)).toBe('a-u3.png');
    });
});
