import { describe, expect, it } from "vitest";

import { assignAssetSlot, buildAssetTag } from "@/lib/assetTag";

describe("assignAssetSlot", () => {
    it("同名复用原槽位，新名取最大槽位 + 1", () => {
        expect(assignAssetSlot("", "小兔子")).toBe(1);
        expect(assignAssetSlot("[character1:小兔子]", "小兔子")).toBe(1);
        expect(assignAssetSlot("[character1:小兔子]", "小狗")).toBe(2);
        // 同一个名字第二次出现不新增槽位
        expect(assignAssetSlot("[character1:小兔子] [character2:小狗]", "小兔子")).toBe(1);
    });

    it("取最大 + 1 而不是数量 + 1，避免与已有槽位撞号", () => {
        // 只剩 [character3:…] 时，下一个必须是 4 —— 用数量算会得到 2，直接撞进第 3 张图
        expect(assignAssetSlot("[character3:小兔子]", "小狗")).toBe(4);
    });

    it("名字里的正则元字符按字面处理", () => {
        const prompt = "[character1:卖猪肉的（3）]";
        expect(assignAssetSlot(prompt, "卖猪肉的（3）")).toBe(1);
        expect(() => assignAssetSlot(prompt, "卖猪肉的（3）")).not.toThrow();
    });

    it("不认识的非数字标签不算槽位", () => {
        expect(assignAssetSlot("[scene:县衙]", "小兔子")).toBe(1);
    });
});

describe("buildAssetTag", () => {
    it("产出解析器认的 [characterN:名字] 形式", () => {
        expect(buildAssetTag("", "小兔子")).toBe("[character1:小兔子]");
        expect(buildAssetTag("[character1:小兔子]", "小狗")).toBe("[character2:小狗]");
    });
});
