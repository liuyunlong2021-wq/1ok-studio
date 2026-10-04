export type ShotTiming = { count: number; duration: number | null; missingCount: number };

export function selectedShotTiming(frames: { id: string; duration?: number | null }[], ids: string[]): ShotTiming {
    const byId = new Map(frames.map(frame => [frame.id, frame]));
    let duration = 0;
    let missingCount = 0;
    for (const id of ids) {
        const value = byId.get(id)?.duration;
        if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) missingCount++;
        else duration += value;
    }
    return { count: ids.length, duration: ids.length && !missingCount ? duration : null, missingCount };
}
