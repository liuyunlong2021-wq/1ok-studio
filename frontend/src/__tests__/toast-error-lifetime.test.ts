/**
 * 错误 toast 不再「永久驻留」。
 *
 * 2026-09-22 用户实测：App 窗口开了 23 小时，屏幕右下角还挂着**昨天**那次的
 * 「剧本解析失败」，看着像刚刚发生的。根因就是 `toast.error` 的 autoCloseMs=0
 * （只能手动关）。现在给 30 秒：够看清 / 复制详情，又不会跨小时糊在界面上。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { toast, useToastStore } from "@/store/toastStore";

describe("toast.error 的生存期", () => {
    beforeEach(() => {
        vi.useFakeTimers();
        useToastStore.setState({ toasts: [] });
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("30 秒后自己消失（不再永远挂着）", () => {
        toast.error("剧本解析失败", { body: "Jiucaihezi API error: 520" });
        expect(useToastStore.getState().toasts).toHaveLength(1);

        vi.advanceTimersByTime(29_000);
        expect(useToastStore.getState().toasts, "半分钟不到就消失会来不及看").toHaveLength(1);

        vi.advanceTimersByTime(2_000);
        expect(useToastStore.getState().toasts).toHaveLength(0);
    });

    it("调用方仍可显式要求它留着手动关（传 autoCloseMs: 0）", () => {
        toast.error("必须看到", { autoCloseMs: 0 });

        vi.advanceTimersByTime(10 * 60_000);
        expect(useToastStore.getState().toasts).toHaveLength(1);
    });
});
