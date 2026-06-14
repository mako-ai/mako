import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createApiClient } from "./client";

/**
 * Tests for the spec-typed API client: correct URL/method construction,
 * typed response flow, request-body serialization, path-param substitution,
 * and the workspace-header middleware.
 */

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("typed API client", () => {
  beforeEach(() => {
    // The auth middleware reads localStorage; provide a stub in the node env.
    (globalThis as { localStorage?: Storage }).localStorage = {
      getItem: vi.fn(() => "ws_123"),
      setItem: vi.fn(),
      removeItem: vi.fn(),
      clear: vi.fn(),
      key: vi.fn(),
      length: 0,
    } as unknown as Storage;
  });

  afterEach(() => {
    delete (globalThis as { localStorage?: Storage }).localStorage;
    vi.restoreAllMocks();
  });

  it("GET resolves the spec path and returns a typed body", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        success: true,
        data: [
          {
            type: "stripe",
            name: "Stripe",
            version: "1.0.0",
            description: "Payments",
            supportedEntities: ["charge"],
          },
        ],
      }),
    );
    const client = createApiClient(
      "https://test.local",
      fetchMock as unknown as typeof fetch,
    );

    const { data, error } = await client.GET("/api/connectors/types");

    expect(error).toBeUndefined();
    // Response is typed: `data.data` is the connector metadata array.
    expect(data?.success).toBe(true);
    expect(data?.data[0]?.type).toBe("stripe");

    const request = fetchMock.mock.calls[0][0] as Request;
    expect(request.method).toBe("GET");
    expect(request.url).toBe("https://test.local/api/connectors/types");
  });

  it("injects the active workspace id as x-workspace-id", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ success: true }));
    const client = createApiClient(
      "https://test.local",
      fetchMock as unknown as typeof fetch,
    );

    await client.GET("/api/workspaces/{workspaceId}/custom-prompt", {
      params: { path: { workspaceId: "ws_123" } },
    });

    const request = fetchMock.mock.calls[0][0] as Request;
    // Path parameter is substituted into the URL.
    expect(request.url).toBe(
      "https://test.local/api/workspaces/ws_123/custom-prompt",
    );
    expect(request.headers.get("x-workspace-id")).toBe("ws_123");
  });

  it("serializes a typed request body for write endpoints", async () => {
    const captured: { body?: string } = {};
    const fetchMock = vi.fn(async (req: Request) => {
      captured.body = await req.text();
      return jsonResponse({ success: true, message: "ok" });
    });
    const client = createApiClient(
      "https://test.local",
      fetchMock as unknown as typeof fetch,
    );

    await client.PUT("/api/workspaces/{workspaceId}/custom-prompt", {
      params: { path: { workspaceId: "ws_123" } },
      body: { content: "# Prompt" },
    });

    const request = fetchMock.mock.calls[0][0] as Request;
    expect(request.method).toBe("PUT");
    expect(JSON.parse(captured.body ?? "{}")).toEqual({ content: "# Prompt" });
  });
});
