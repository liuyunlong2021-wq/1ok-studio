import { describe, expect, it } from "vitest";

import { deriveSegmentReferences } from "@/lib/segmentReferences";

/** 造一条资产：给 url 就"有图"，不给就"没图"。 */
const character = (id: string, name: string, url?: string) => ({
    id,
    name,
    reference_sheet: url ? { selected_image_id: "v", image_variants: [{ id: "v", url }] } : undefined,
});
const scene = (id: string, name: string, url?: string) => ({
    id,
    name,
    image_asset: url ? { selected_id: "v", variants: [{ id: "v", url }] } : undefined,
});
const prop = (id: string, name: string, url?: string) => scene(id, name, url);
const frame = (id: string, character_ids: string[], scene_id?: string, prop_ids: string[] = []) => ({
    id,
    character_ids,
    scene_id,
    prop_ids,
});

const ids = (...names: string[]) => names;

describe("deriveSegmentReferences", () => {
    it("按资产在段内的首次出现顺序排，同镜内先场景后角色后道具", () => {
        const frames = [
            frame("f1", ["c-x"], "s-a"),
            frame("f2", ["c-y"], "s-a"),
            frame("f3", ["c-x"], undefined, ["p-1"]),
        ];
        const assets = {
            characters: [character("c-x", "刘备", "uploads/x.png"), character("c-y", "关羽", "uploads/y.png")],
            scenes: [scene("s-a", "县衙", "uploads/a.png")],
            props: [prop("p-1", "招兵布告", "uploads/p.png")],
        };

        const { references, misses } = deriveSegmentReferences(ids("f1", "f2", "f3"), frames, assets);

        expect(references.map((r) => r.name)).toEqual(["县衙", "刘备", "关羽", "招兵布告"]);
        expect(references.map((r) => r.type)).toEqual(["场景", "角色", "角色", "道具"]);
        expect(references.map((r) => r.url)).toEqual([
            "uploads/a.png",
            "uploads/x.png",
            "uploads/y.png",
            "uploads/p.png",
        ]);
        expect(misses).toEqual([]);
    });

    it("按 id 去重：同名不同 id 的资产各占一张，不合并", () => {
        const frames = [frame("f1", ["c-1", "c-2"], "s-a")];
        const assets = {
            characters: [character("c-1", "路人甲", "uploads/1.png"), character("c-2", "路人甲", "uploads/2.png")],
            scenes: [scene("s-a", "街口", "uploads/a.png")],
        };

        const { references } = deriveSegmentReferences(ids("f1"), frames, assets);

        expect(references.map((r) => r.url)).toEqual(["uploads/a.png", "uploads/1.png", "uploads/2.png"]);
    });

    it("没图的资产不占槽位，进 no-image 且带上是第几镜", () => {
        const frames = [frame("f1", ["c-x"], "s-a"), frame("f2", ["c-y"], "s-a")];
        const assets = {
            characters: [character("c-x", "刘备"), character("c-y", "关羽", "uploads/y.png")],
            scenes: [scene("s-a", "县衙", "uploads/a.png")],
        };

        const { references, misses } = deriveSegmentReferences(ids("f1", "f2"), frames, assets);

        expect(references.map((r) => r.name)).toEqual(["县衙", "关羽"]);
        expect(misses).toEqual([{ name: "刘备", type: "角色", shot: 1, reason: "no-image" }]);
    });

    it("引用了项目里不存在的资产 id 时报 missing-asset，不静默吞掉", () => {
        const frames = [frame("f1", ["c-ghost"], "s-a")];
        const assets = { characters: [], scenes: [scene("s-a", "县衙", "uploads/a.png")] };

        const { references, misses } = deriveSegmentReferences(ids("f1"), frames, assets);

        expect(references.map((r) => r.name)).toEqual(["县衙"]);
        expect(misses).toEqual([{ name: "c-ghost", type: "角色", shot: 1, reason: "missing-asset" }]);
    });

    it("超 9 张不截断（上限以后会放宽，由用户自己删镜头）", () => {
        const chars = Array.from({ length: 11 }, (_, i) => character(`c-${i}`, `角色${i}`, `uploads/${i}.png`));
        const frames = [
            frame(
                "f1",
                chars.map((c) => c.id),
                "s-a",
            ),
        ];

        const { references } = deriveSegmentReferences(ids("f1"), frames, {
            characters: chars,
            scenes: [scene("s-a", "县衙", "uploads/a.png")],
        });

        expect(references).toHaveLength(12);
    });

    it("空选择返回空，镜头不在列表里也不抛错", () => {
        expect(deriveSegmentReferences([], [], {})).toEqual({ references: [], misses: [] });
        expect(deriveSegmentReferences(ids("nope"), [], {})).toEqual({ references: [], misses: [] });
    });
});
