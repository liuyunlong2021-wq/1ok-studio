import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import ProductionExtractionPreview from "./ProductionExtractionPreview";

describe("engineering extraction preview", () => {
    it("shows complete information and edits a binding without re-extracting", () => {
        const onChange = vi.fn();
        const preview = {
            characters: [{ id: "c1", name: "莱拉", description: "皇女，手腕有9527烙印", looks: [
                { id: "work", name: "工装", description: "补丁工装、带泥皮靴、破外套" },
                { id: "dress", name: "礼服", description: "白色礼服" },
            ] }], scenes: [], props: [],
            shot_bindings: [{ shot_number: 7, characters: [{ character_id: "c1", look_id: "work" }], prop_ids: [], scene_id: null }],
        };
        render(<ProductionExtractionPreview preview={preview} onChange={onChange} />);
        expect(screen.getByText("皇女，手腕有9527烙印")).toBeTruthy();
        expect(screen.getByText("补丁工装、带泥皮靴、破外套")).toBeTruthy();
        fireEvent.change(screen.getByLabelText("镜头7 莱拉造型"), { target: { value: "dress" } });
        expect(onChange).toHaveBeenCalledOnce();
        expect(onChange.mock.calls[0][0].shot_bindings[0].characters[0].look_id).toBe("dress");
        expect(preview.shot_bindings[0].characters[0].look_id).toBe("work");
        expect(onChange.mock.calls[0][0].characters).toBe(preview.characters);
    });
});
