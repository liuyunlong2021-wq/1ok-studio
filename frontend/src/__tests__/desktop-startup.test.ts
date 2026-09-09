import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  checkBackendReady: vi.fn(),
}));

vi.mock("@/lib/transport", () => ({
  isTauri: () => true,
  checkBackendReady: mocks.checkBackendReady,
}));

import { useDesktopStore } from "@/store/desktopStore";

describe("desktop startup", () => {
  beforeEach(() => {
    mocks.checkBackendReady.mockReset();
    useDesktopStore.setState({
      isDesktop: false,
      backendReady: false,
      backendChecking: false,
      backendError: null,
    });
  });

  it("waits for one shared backend health check", async () => {
    mocks.checkBackendReady.mockResolvedValue(true);

    useDesktopStore.getState().init();
    useDesktopStore.getState().init();

    await vi.waitFor(() => expect(useDesktopStore.getState().backendReady).toBe(true));
    expect(mocks.checkBackendReady).toHaveBeenCalledTimes(1);
  });

  it("shows the sidecar log path instead of waiting forever", async () => {
    vi.useFakeTimers();
    mocks.checkBackendReady.mockResolvedValue(false);

    useDesktopStore.getState().init();
    await vi.advanceTimersByTimeAsync(30_200);

    expect(useDesktopStore.getState().backendError).toContain("sidecar.log");
    vi.useRealTimers();
  });
});
