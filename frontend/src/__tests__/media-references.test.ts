import { describe, expect, it } from "vitest";

import { mergeReferences, MODE_CONFIG } from "@/components/modules/playground/mediaModes";

const multi = { multiple: true, maxFiles: 9 }; // t2i / r2v
const single = { multiple: false, maxFiles: 1 }; // i2i / i2v / v2v

describe("mergeReferences", () => {
    it("多参考模式：追加到末尾，已有的顺序不动", () => {
        expect(mergeReferences(["a.png"], ["b.png", "c.png"], multi)).toEqual(["a.png", "b.png", "c.png"]);
    });

    it("已经在里面的不再加（同一张图加两次只白占配额）", () => {
        expect(mergeReferences(["a.png"], ["a.png", "b.png", "a.png"], multi)).toEqual(["a.png", "b.png"]);
    });

    it("超出上限的丢掉尾巴", () => {
        expect(mergeReferences(["a", "b", "c"], ["d", "e"], { multiple: true, maxFiles: 4 })).toEqual([
            "a",
            "b",
            "c",
            "d",
        ]);
    });

    it("满员 / 没新东西时返回同一个数组引用（调用方据此跳过 setState）", () => {
        const current = ["a", "b"];
        expect(mergeReferences(current, ["c"], { multiple: true, maxFiles: 2 })).toBe(current);
        expect(mergeReferences(current, [], multi)).toBe(current);
        expect(mergeReferences(current, ["a"], multi)).toBe(current);
        expect(mergeReferences(current, ["", "a"], multi)).toBe(current);
    });

    it("单参考模式是替换而不是追加（追加会多出一张界面看不见、但照样送进生成的图）", () => {
        expect(mergeReferences(["source.mp4"], ["new.mp4"], single)).toEqual(["new.mp4"]);
    });

    it("单参考模式一次给多张也只留最后一张（勾选顺序里后选的算数）", () => {
        expect(mergeReferences([], ["x.png", "y.png"], single)).toEqual(["y.png"]);
        // y.png 本来就在里面 → 只有 x.png 算新的，替换掉 y.png
        expect(mergeReferences(["y.png"], ["x.png", "y.png"], single)).toEqual(["x.png"]);
        // 只有已经在里面的那张 → 不算换图，原样返回
        const current = ["y.png"];
        expect(mergeReferences(current, ["y.png"], single)).toBe(current);
    });
});

describe("MODE_CONFIG 的容量约定", () => {
    it("多参考模式的上限就是后端收的参考图张数（t2i / r2v = 9）", () => {
        expect(MODE_CONFIG.t2i?.maxFiles).toBe(9);
        expect(MODE_CONFIG.r2v?.maxFiles).toBe(9);
        expect(MODE_CONFIG.t2i?.multiple).toBe(true);
    });

    it("单参考模式必须 multiple=false 且 maxFiles=1（否则替换语义不成立）", () => {
        for (const mode of ["i2i", "i2v", "v2v"] as const) {
            expect(MODE_CONFIG[mode]?.multiple).toBe(false);
            expect(MODE_CONFIG[mode]?.maxFiles).toBe(1);
        }
    });
});
