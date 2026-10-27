import { describe, expect, it } from "vitest";
import { characterImageUrl } from "@/lib/characterImage";
import type { Character } from "@/store/projectStore";

describe("character look image resolution", () => {
    const character: Character = {
        id: "c1", name: "莱拉", image_url: "legacy.png",
        looks: [
            { id: "work", name: "工装", description: "工装", reference_sheet: { image_variants: [{ id: "a", url: "work.png", created_at: 1 }], selected_image_id: "a" } },
            { id: "dress", name: "礼服", description: "礼服", reference_sheet: { image_variants: [], selected_image_id: null } },
        ],
    };
    it("resolves the exact look and never borrows another outfit", () => {
        expect(characterImageUrl(character, "work")).toBe("work.png");
        expect(characterImageUrl(character, "dress")).toBeUndefined();
        expect(characterImageUrl(character, "unknown")).toBeUndefined();
    });
    it("keeps old characters readable", () => {
        expect(characterImageUrl({ id: "old", name: "旧角色", image_url: "old.png" })).toBe("old.png");
    });
});
