// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAppV2Store } from "./appV2Store";
import { useRealtimeStore } from "./realtimeStore";

class FakeEventSource {
  static latest: FakeEventSource | undefined;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor() {
    FakeEventSource.latest = this;
  }

  addEventListener(): void {}
  close(): void {}
}

describe("realtime Apps v2 wake reconciliation", () => {
  beforeEach(() => {
    vi.stubGlobal("EventSource", FakeEventSource);
    FakeEventSource.latest = undefined;
  });

  afterEach(() => {
    useRealtimeStore.getState().disconnect();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("refreshes loaded Apps v2 projects on reconnect and window focus", () => {
    const refreshLoadedProjects = vi
      .spyOn(useAppV2Store.getState(), "refreshLoadedProjects")
      .mockResolvedValue();

    useRealtimeStore.getState().connect("workspace-1");
    FakeEventSource.latest?.onopen?.();
    expect(refreshLoadedProjects).toHaveBeenCalledWith("workspace-1");

    refreshLoadedProjects.mockClear();
    window.dispatchEvent(new Event("focus"));
    expect(refreshLoadedProjects).toHaveBeenCalledWith("workspace-1");
  });
});
