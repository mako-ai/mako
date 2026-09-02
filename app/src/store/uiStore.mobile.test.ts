// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { useUIStore } from "./uiStore";

/**
 * The phone shell's navigation contract: a FIXED bottom nav (Browse · View ·
 * Ask) plus per-kind panes inside View. Nothing here may leak into the
 * persisted slice — a reload lands on Ask with the console on its query.
 */
describe("uiStore mobile navigation", () => {
  beforeEach(() => {
    useUIStore.getState().reset();
  });

  it("starts on Ask with the console on query and the app on preview", () => {
    const s = useUIStore.getState();
    expect(s.mobileTab).toBe("ask");
    expect(s.mobileConsolePane).toBe("query");
    expect(s.mobileAppPane).toBe("preview");
  });

  it("switches tabs without touching the per-kind panes", () => {
    const s = useUIStore.getState();
    s.setMobileConsolePane("results");
    s.setMobileAppPane("terminal");
    s.setMobileTab("browse");
    expect(useUIStore.getState().mobileTab).toBe("browse");
    expect(useUIStore.getState().mobileConsolePane).toBe("results");
    expect(useUIStore.getState().mobileAppPane).toBe("terminal");
    s.setMobileTab("view");
    expect(useUIStore.getState().mobileTab).toBe("view");
  });

  it("does not persist any mobile navigation state", () => {
    const s = useUIStore.getState();
    s.setMobileTab("view");
    s.setMobileConsolePane("results");
    s.setMobileAppPane("terminal");
    // The store persists under this key; the desktop layout fields are in
    // there, the phone navigation must not be.
    const raw = localStorage.getItem("ui-store");
    expect(raw).not.toBeNull();
    expect(raw).toContain("leftPaneOpen");
    expect(raw).not.toContain("mobileTab");
    expect(raw).not.toContain("mobileConsolePane");
    expect(raw).not.toContain("mobileAppPane");
  });
});
