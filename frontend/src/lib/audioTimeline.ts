/**
 * 全集声音的时间轴刻度。
 *
 * 这一步的音频**纯粹给人听**，程序不做任何切分 —— 「哪几个分镜一组」由人听完
 * 自己判断。UI 只需要把「到这里是 30 秒」画出来（视频模型单次上限 30 秒），
 * 剩下的交给耳朵。
 */

/** 视频模型单次生成的时长上限。刻度间隔就按它来。 */
export const DEFAULT_STEP_MS = 30_000;

/** 毫秒 → "m:ss"（秒补零）。 */
export function formatClock(ms: number): string {
    const totalSeconds = Math.max(0, Math.floor((Number.isFinite(ms) ? ms : 0) / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/**
 * 生成时间轴刻度。最后一条不超出音频时长。
 *
 * 95 秒 → 0:00 / 0:30 / 1:00 / 1:30（不会画出 2:00）。
 * 时长未知或非正数 → 空数组（不画刻度，总比画错的强）。
 */
export function buildThirtySecondMarks(
    durationMs: number,
    stepMs: number = DEFAULT_STEP_MS
): { ms: number; label: string }[] {
    if (!Number.isFinite(durationMs) || durationMs <= 0) return [];
    if (!Number.isFinite(stepMs) || stepMs <= 0) return [];

    const marks: { ms: number; label: string }[] = [];
    for (let ms = 0; ms <= durationMs; ms += stepMs) {
        marks.push({ ms, label: formatClock(ms) });
    }
    return marks;
}
