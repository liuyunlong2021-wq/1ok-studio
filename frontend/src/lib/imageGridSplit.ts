/**
 * imageGridSplit — 把一张图按 N×M 切开（MJ 一次出 4 张拼成一张的成图）。
 * 几何计算是纯函数；裁剪在浏览器 canvas 里做，不调任何上游接口。
 * 与 jiucaihezi-app 的 src/utils/imageGridSplit.ts 保持同一套网格与取整规则。
 */

export interface ImageSplitGrid {
    cols: number;
    rows: number;
}

export const IMAGE_SPLIT_GRIDS: ImageSplitGrid[] = [
    { cols: 2, rows: 2 },
    { cols: 1, rows: 2 },
    { cols: 2, rows: 1 },
    { cols: 3, rows: 3 },
];

export function imageSplitLabel(grid: ImageSplitGrid): string {
    return `${grid.rows}×${grid.cols}`;
}

export interface ImageSplitRect {
    index: number;
    x: number;
    y: number;
    width: number;
    height: number;
}

/** 边界整数分配、最后一行/列吃到边缘：不重叠、不留缝。index 从左上到右下，1 起。 */
export function imageSplitRects(width: number, height: number, grid: ImageSplitGrid): ImageSplitRect[] {
    const { cols, rows } = grid;
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return [];
    if (cols < 1 || rows < 1) return [];
    const rects: ImageSplitRect[] = [];
    for (let row = 0; row < rows; row += 1) {
        const y = Math.round((height * row) / rows);
        const bottom = row === rows - 1 ? height : Math.round((height * (row + 1)) / rows);
        for (let col = 0; col < cols; col += 1) {
            const x = Math.round((width * col) / cols);
            const right = col === cols - 1 ? width : Math.round((width * (col + 1)) / cols);
            rects.push({ index: row * cols + col + 1, x, y, width: right - x, height: bottom - y });
        }
    }
    return rects;
}

export function tileFilename(baseName: string, index: number): string {
    const base = String(baseName || "image").replace(/\.[^.]+$/, "") || "image";
    return `${base}-u${index}.png`;
}

/** 从原图字节裁出选中的格子。 */
export async function cropImageTiles(
    blob: Blob,
    grid: ImageSplitGrid,
    selectedIndexes: number[],
    baseName = "image",
): Promise<File[]> {
    const bitmap = await createImageBitmap(blob);
    try {
        const rects = imageSplitRects(bitmap.width, bitmap.height, grid)
            .filter((rect) => selectedIndexes.includes(rect.index));
        const files: File[] = [];
        for (const rect of rects) {
            const canvas = document.createElement("canvas");
            canvas.width = rect.width;
            canvas.height = rect.height;
            const context = canvas.getContext("2d");
            if (!context) throw new Error("canvas unavailable");
            context.drawImage(bitmap, rect.x, rect.y, rect.width, rect.height, 0, 0, rect.width, rect.height);
            const tile = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
            if (!tile) throw new Error("tile export failed");
            files.push(new File([tile], tileFilename(baseName, rect.index), { type: "image/png" }));
        }
        return files;
    } finally {
        bitmap.close?.();
    }
}
