import { describe, expect, it } from "vitest";

import { updateFrameSelection } from "@/lib/frameSelection";

const frames = ["1", "2", "3", "4", "5", "6", "7", "8"];

describe("updateFrameSelection", () => {
    it("点已选中的镜头只取消它自己，不动别的镜头", () => {
        // 端点：只少掉点的那一张
        expect(updateFrameSelection(frames, frames.slice(0, 7), "1", "7")).toEqual({
            selectedIds: frames.slice(0, 6),
            anchorId: "1",
        });
        // 中间：过去会「朝锚点收缩」砍掉一串，现在只剩被点的那张消失
        expect(updateFrameSelection(frames, frames.slice(0, 7), "1", "4")).toEqual({
            selectedIds: ["1", "2", "3", "5", "6", "7"],
            anchorId: "1",
        });
    });

    it("锚点自己被取消时改锚到剩余选区最靠前的一张", () => {
        expect(updateFrameSelection(frames, frames.slice(0, 7), "1", "1")).toEqual({
            selectedIds: frames.slice(1, 7),
            anchorId: "2",
        });
    });

    it("点未选中的镜头是并集（加一段），绝不会撤销已选", () => {
        expect(updateFrameSelection(frames, ["3"], "3", "7").selectedIds).toEqual(frames.slice(2, 7));
        expect(updateFrameSelection(frames, ["3"], "3", "3")).toEqual({ selectedIds: [], anchorId: null });
    });

    it("adds a missed earlier shot without dropping the rest of the range", () => {
        const shotIds = Array.from({ length: 12 }, (_, index) => String(index + 1));
        // 用户实际路径：点 2 → 点 11 → 发现漏了 1，回头补 1。
        const afterStart = updateFrameSelection(shotIds, [], null, "2");
        expect(afterStart).toEqual({ selectedIds: ["2"], anchorId: "2" });

        const afterEnd = updateFrameSelection(shotIds, afterStart.selectedIds, afterStart.anchorId, "11");
        expect(afterEnd).toEqual({ selectedIds: shotIds.slice(1, 11), anchorId: "2" });

        const afterPatch = updateFrameSelection(shotIds, afterEnd.selectedIds, afterEnd.anchorId, "1");
        expect(afterPatch.selectedIds).toEqual(shotIds.slice(0, 11)); // 1..11，不再塌成 1..2
        expect(afterPatch.anchorId).toBe("2");
    });

    it("点到区间中间已选中的镜头，只少那一张（用户报的第二例）", () => {
        const shotIds = Array.from({ length: 12 }, (_, index) => String(index + 1));
        const selected = shotIds.slice(1, 11); // 2..11
        const after = updateFrameSelection(shotIds, selected, "2", "10");
        expect(after.selectedIds).toEqual([...shotIds.slice(1, 9), "11"]); // 2..9 + 11，只有 10 消失
        expect(after.anchorId).toBe("2");
    });

    it("extends the tail and keeps everything before it", () => {
        const base = frames.slice(1, 7); // 2..7，锚点 2
        expect(updateFrameSelection(frames, base, "2", "8").selectedIds).toEqual(frames.slice(1));
    });
});
