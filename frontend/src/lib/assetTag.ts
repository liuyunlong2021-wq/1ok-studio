/**
 * `[characterN:名称]` 是本仓 R2V 的参考图槽位载体：N-1 就是 `reference_image_urls` 的下标
 * （模型按 N 取第 N 张图）。所以同一个名字必须永远复用同一个 N —— 换个 N 就等于多要一张图，
 * 后面的槽位全部错位。
 *
 * 抽出来的原因：创作台的动作步骤、分镜工作台的资产条、资产抽屉三处各写了一份，而其中
 * 抽屉那份拼的是 `[scene:名字]`（正则只认 `character\d+`，点了没反应）、且用列表下标当 N。
 */

/** 名称里的正则元字符要转义，「卖猪肉的（3）」这类名字不转义会直接抛错。 */
function escapeForRegExp(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 这个资产在当前提示词里的槽位号；没有就返回「最大槽位 + 1」（不是数量 + 1，避免与已有槽位撞号）。 */
export function assignAssetSlot(prompt: string, name: string): number {
    const existing = prompt.match(new RegExp(`\\[character(\\d+):${escapeForRegExp(name)}\\]`));
    if (existing) return parseInt(existing[1], 10);

    let maxSlot = 0;
    const slotPattern = /\[character(\d+):[^\]]+\]/g;
    let match: RegExpExecArray | null;
    while ((match = slotPattern.exec(prompt)) !== null) {
        maxSlot = Math.max(maxSlot, parseInt(match[1], 10));
    }
    return maxSlot > 0 ? maxSlot + 1 : 1;
}

/** 直接给出可以插进提示词的标签。 */
export function buildAssetTag(prompt: string, name: string): string {
    return `[character${assignAssetSlot(prompt, name)}:${name}]`;
}
