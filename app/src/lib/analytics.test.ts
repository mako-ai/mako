import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAnalyticsContext, trackEvent } from "./analytics";

describe("trackEvent", () => {
  beforeEach(() => {
    vi.stubGlobal("window", { dataLayer: [] });
    vi.stubGlobal("crypto", { randomUUID: () => "generated-event-id" });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("adds one stable event_id to flat and nested properties", () => {
    trackEvent("query_executed", { database_type: "postgresql" });

    expect(window.dataLayer).toHaveLength(1);
    expect(window.dataLayer[0]).toMatchObject({
      event: "query_executed",
      event_id: "generated-event-id",
      event_properties: {
        event_id: "generated-event-id",
        database_type: "postgresql",
      },
    });
  });

  it("preserves a server-provided event_id for retry deduplication", () => {
    trackEvent("database_connection_verified", {
      event_id: "existing-event-id",
    });

    expect(window.dataLayer[0]).toMatchObject({
      event_id: "existing-event-id",
      event_properties: { event_id: "existing-event-id" },
    });
  });

  it("adds a stable web surface and session id", () => {
    const values = new Map<string, string>();
    vi.stubGlobal("window", {
      dataLayer: [],
      sessionStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
      },
    });

    const first = getAnalyticsContext();
    const second = getAnalyticsContext();

    expect(first).toMatchObject({
      app_surface: "web",
      app_session_id: "generated-event-id",
    });
    expect(second.app_session_id).toBe(first.app_session_id);
  });

  it("adds persistent desktop installation and binary metadata", () => {
    const session = new Map<string, string>();
    const local = new Map<string, string>();
    vi.stubGlobal("window", {
      dataLayer: [],
      makoDesktop: {
        version: "0.3.0",
        platform: "darwin",
        arch: "arm64",
      },
      sessionStorage: {
        getItem: (key: string) => session.get(key) ?? null,
        setItem: (key: string, value: string) => session.set(key, value),
      },
      localStorage: {
        getItem: (key: string) => local.get(key) ?? null,
        setItem: (key: string, value: string) => local.set(key, value),
      },
    });

    trackEvent("app_session_started");

    expect(window.dataLayer[0]).toMatchObject({
      app_surface: "desktop",
      desktop_installation_id: "generated-event-id",
      app_version: "0.3.0",
      app_os: "darwin",
      app_arch: "arm64",
      event_properties: {
        app_surface: "desktop",
        desktop_installation_id: "generated-event-id",
      },
    });
  });
});
