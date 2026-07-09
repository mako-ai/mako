import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { trackEvent } from "./analytics";

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
});
