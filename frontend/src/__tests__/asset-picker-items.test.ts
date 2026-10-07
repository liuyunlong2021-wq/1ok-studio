import { describe, expect, it } from "vitest";

import { assetPickerItems, type AssetSource } from "@/lib/assetLibrary";

/** 造一条资产：给 url 就"有图"，不给就"没图"。（只填取图用得上的字段） */
const character = (id: string, name: string, url?: string) => ({
    id,
    name,
    description: "",
    full_body_asset: url ? { selected_id: "v", variants: [{ id: "v", url, created_at: 0 }] } : undefined,
});
const scene = (id: string, name: string, url?: string) => ({
    id,
    name,
    description: "",
    image_asset: url ? { selected_id: "v", variants: [{ id: "v", url, created_at: 0 }] } : undefined,
});

const source = (
    id: string,
    name: string,
    kind: AssetSource["kind"],
    assets: Partial<Pick<AssetSource, "characters" | "scenes" | "props">>,
): AssetSource => ({
    id,
    rawId: id,
    name,
    kind,
    characters: assets.characters ?? [],
    scenes: assets.scenes ?? [],
    props: assets.props ?? [],
});

describe("assetPickerItems", () => {
    it("媒体引用直接交给后端，缩略图地址是 /files/ 的完整地址", () => {
        const items = assetPickerItems([source("global", "全局 / 共享", "global", { characters: [character("c1", "刘备", "uploads/liubei.png")] })]);

        expect(items).toHaveLength(1);
        // ref 保持 output/ 相对引用（input_media 就是这么写的，后端两处都认）
        expect(items[0].ref).toBe("uploads/liubei.png");
        expect(items[0].url.endsWith("/files/uploads/liubei.png")).toBe(true);
        // 资产支持多版本后，标签带「图类型 · 版本 N」（见 assetImageVersions）。
        expect(items[0].label).toBe("刘备 · 全身图 · 版本 1");
    });

    it("没图的资产不进列表（选进去也当不了参考图）", () => {
        const items = assetPickerItems([
            source("p1", "三国", "project", {
                characters: [character("c1", "屠夫", "assets/characters/t.png"), character("c2", "路人", undefined)],
                scenes: [scene("s1", "汉朝街道", undefined)],
            }),
        ]);

        expect(items.map((i) => i.label)).toEqual(["屠夫 · 全身图 · 版本 1"]);
    });

    it("顺序＝源顺序，源内 角色 → 场景 → 道具", () => {
        const items = assetPickerItems([
            source("series-1", "孔子系列", "series", {
                props: [scene("p1", "招兵布告", "assets/props/a.png")],
                characters: [character("c1", "孔子", "assets/characters/k.png")],
                scenes: [scene("s1", "古朴学堂", "assets/scenes/s.png")],
            }),
            source("project-2", "三国", "project", {
                characters: [character("c2", "刘备", "assets/characters/l.png")],
            }),
        ]);

        expect(items.map((i) => `${i.sourceName}/${i.label}`)).toEqual([
            "孔子系列/孔子 · 全身图 · 版本 1",
            "孔子系列/古朴学堂 · 资产图 · 版本 1",
            "孔子系列/招兵布告 · 资产图 · 版本 1",
            "三国/刘备 · 全身图 · 版本 1",
        ]);
    });

    it("同一个资产在两处出现只列一条（同 id 不重复）", () => {
        const shared = character("c1", "73号", "assets/characters/73.png");
        const items = assetPickerItems([
            source("series-1", "系列", "series", { characters: [shared] }),
            source("global", "全局 / 共享", "global", { characters: [shared] }),
        ]);

        expect(items).toHaveLength(1);
        expect(items[0].sourceName).toBe("系列");
    });

    it("按扩展名区分图 / 视频（资产库里也可能存在收藏来的视频）", () => {
        const items = assetPickerItems([
            source("global", "全局 / 共享", "global", {
                props: [scene("p1", "打斗片段", "assets/props/clip.mp4"), scene("p2", "招兵布告", "assets/props/a.PNG")],
            }),
        ]);

        expect(items.map((i) => i.type)).toEqual(["video", "image"]);
    });

    it("空资产库给空列表（弹窗自己显示空态）", () => {
        expect(assetPickerItems([])).toEqual([]);
        expect(assetPickerItems([source("global", "全局 / 共享", "global", {})])).toEqual([]);
    });
});
