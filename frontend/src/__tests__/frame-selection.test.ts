import { describe, expect, it } from "vitest";

import { updateFrameSelection } from "@/lib/frameSelection";

const frames = ["1", "2", "3", "4", "5", "6", "7", "8"];

describe("updateFrameSelection", () => {
    it("shrinks a selected range from either end", () => {
        expect(updateFrameSelection(frames, frames.slice(0, 7), "1", "7")).toEqual({
            selectedIds: frames.slice(0, 6),
            anchorId: "1",
        });
        expect(updateFrameSelection(frames, frames.slice(0, 7), "1", "1")).toEqual({
            selectedIds: frames.slice(1, 7),
            anchorId: "7",
        });
    });

    it("keeps selection continuous when toggling or extending it", () => {
        expect(updateFrameSelection(frames, frames.slice(0, 7), "1", "4").selectedIds).toEqual(frames.slice(0, 3));
        expect(updateFrameSelection(frames, ["3"], "3", "3")).toEqual({ selectedIds: [], anchorId: null });
        expect(updateFrameSelection(frames, ["3"], "3", "7").selectedIds).toEqual(frames.slice(2, 7));
    });
});
