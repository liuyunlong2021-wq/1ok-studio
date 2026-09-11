type FrameSelection = {
    selectedIds: string[];
    anchorId: string | null;
};

/**
 * 「连续镜头」选区状态机：
 * 1. 点未选中的镜头 → 加入「锚点 → 该镜头」整段，与现有选区取并集（只加不减）；
 *    空选区时它就是新锚点（点起点 → 点终点）。
 * 2. 点已选中的镜头 → 只取消它自己。不碰任何其他镜头。
 * 3. 取消到空 → 回到初始状态（锚点清空）。
 *
 * 不变式：一次点击要么只增加，要么只删掉被点的那一张。
 * （此前的「朝锚点收缩」会一次砍掉一串，导致“点一个镜头另一个也取消了”。）
 */
export function updateFrameSelection(
    frameIds: string[],
    selectedIds: string[],
    anchorId: string | null,
    clickedId: string,
): FrameSelection {
    const clickedIndex = frameIds.indexOf(clickedId);
    if (clickedIndex < 0) return { selectedIds, anchorId };

    // 点已选中的镜头 → 只取消它
    if (selectedIds.includes(clickedId)) {
        const next = selectedIds.filter((id) => id !== clickedId);
        if (next.length === 0) return { selectedIds: [], anchorId: null };
        // 锚点被取消时，改用剩余选区里最靠前的那张，后续仍然能拉区间
        const nextAnchor = anchorId && next.includes(anchorId)
            ? anchorId
            : frameIds.find((id) => next.includes(id)) ?? next[0];
        return { selectedIds: next, anchorId: nextAnchor };
    }

    // 点未选中的镜头 → 加一段（并集）。锚点丢了就只加它自己并把它作为新锚点。
    if (!anchorId || !selectedIds.includes(anchorId)) {
        const merged = new Set([...selectedIds, clickedId]);
        return { selectedIds: frameIds.filter((id) => merged.has(id)), anchorId: clickedId };
    }

    const anchorIndex = frameIds.indexOf(anchorId);
    const [from, to] = anchorIndex < clickedIndex
        ? [anchorIndex, clickedIndex]
        : [clickedIndex, anchorIndex];
    const merged = new Set([...selectedIds, ...frameIds.slice(from, to + 1)]);
    return { selectedIds: frameIds.filter((id) => merged.has(id)), anchorId };
}
