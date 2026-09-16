/**
 * 全集声音的时间轴刻度。
 *
 * 这一步的音频**纯粹给人听**，程序不做任何切分 —— 「哪几个分镜一组」由人听完
 * 自己判断。UI 要做的是把时间说清楚：主刻度 30 秒（视频模型单次上限，判断线），
 * 次刻度 10 秒（更细的参照），再加上播放位置 / 悬停 / 落点三个读数。
 */

/** 视频模型单次生成的时长上限。刻度间隔就按它来。 */
export const DEFAULT_STEP_MS = 30_000;

/** 次刻度间隔。主刻度是判断线（30 秒上限），次刻度只是更细的参照。 */
export const SUB_STEP_MS = 10_000;

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

/**
 * 次刻度位置（毫秒）。与主刻度重合的跳过 —— 不要在同一根位置画两次。
 *
 * 2 分 05 秒 → 0:10 / 0:20 / 0:40 / 0:50 / 1:10 / 1:20 / 1:40 / 1:50 / 2:00
 * （0:30 / 1:00 / 1:30 / 2:00 是主刻度的位置，2:00 之后超出时长也算上）
 */
export function buildSubMarks(
    durationMs: number,
    stepMs: number = SUB_STEP_MS,
    mainStepMs: number = DEFAULT_STEP_MS
): number[] {
    if (!Number.isFinite(durationMs) || durationMs <= 0) return [];
    if (!Number.isFinite(stepMs) || stepMs <= 0) return [];

    const marks: number[] = [];
    for (let ms = stepMs; ms < durationMs; ms += stepMs) {
        if (mainStepMs > 0 && ms % mainStepMs === 0) continue;
        marks.push(ms);
    }
    return marks;
}
