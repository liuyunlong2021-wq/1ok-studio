type FrameSelection = {
    selectedIds: string[];
    anchorId: string | null;
};

export function updateFrameSelection(
    frameIds: string[],
    selectedIds: string[],
    anchorId: string | null,
    clickedId: string,
): FrameSelection {
    const clickedIndex = frameIds.indexOf(clickedId);
    if (clickedIndex < 0) return { selectedIds, anchorId };
    if (!anchorId) return { selectedIds: [clickedId], anchorId: clickedId };

    const selectedIndexes = selectedIds
        .map((id) => frameIds.indexOf(id))
        .filter((index) => index >= 0)
        .sort((a, b) => a - b);

    if (selectedIds.includes(clickedId)) {
        if (selectedIndexes.length === 1) return { selectedIds: [], anchorId: null };

        const first = selectedIndexes[0];
        const last = selectedIndexes[selectedIndexes.length - 1];
        if (clickedIndex === first) {
            const next = frameIds.slice(first + 1, last + 1);
            return { selectedIds: next, anchorId: anchorId === clickedId ? next[next.length - 1] : anchorId };
        }
        if (clickedIndex === last) {
            const next = frameIds.slice(first, last);
            return { selectedIds: next, anchorId: anchorId === clickedId ? next[0] : anchorId };
        }

        const anchorIndex = frameIds.indexOf(anchorId);
        const next = anchorIndex < clickedIndex
            ? frameIds.slice(anchorIndex, clickedIndex)
            : frameIds.slice(clickedIndex + 1, anchorIndex + 1);
        return { selectedIds: next, anchorId };
    }

    const anchorIndex = frameIds.indexOf(anchorId);
    if (anchorIndex < 0) return { selectedIds: [clickedId], anchorId: clickedId };
    const [from, to] = anchorIndex < clickedIndex
        ? [anchorIndex, clickedIndex]
        : [clickedIndex, anchorIndex];
    return { selectedIds: frameIds.slice(from, to + 1), anchorId };
}
