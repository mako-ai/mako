import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createApiClient,
  POOL_WAITED_HEADER,
  retryUnavailableReads,
  UNAVAILABLE_READ_RETRIES,
} from "./client";
import { unwrap, unwrapBody } from "./result";

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
    const fetchMock = vi.fn(async (_req: Request) =>
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
    const fetchMock = vi.fn(async (_req: Request) =>
      jsonResponse({ success: true }),
    );
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

  it("unwrap surfaces structured API errors with codes", () => {
    expect(() =>
      unwrap({
        error: {
          success: false,
          error: "Preview queries require confirmation",
          code: "PREVIEW_BLOCKED",
        },
        response: jsonResponse({}, 400),
      }),
    ).toThrow("Preview queries require confirmation (PREVIEW_BLOCKED)");
  });

  it("unwrapBody surfaces validation issue messages instead of generic HTTP text", () => {
    expect(() =>
      unwrapBody({
        error: { issues: [{ message: "Name is required" }] },
        response: jsonResponse({}, 400),
      }),
    ).toThrow("Name is required");
  });

  it("unwrap includes otherwise unknown error envelopes", () => {
    expect(() =>
      unwrap({
        error: { failure: { id: "abc123" } },
        response: jsonResponse({}, 500),
      }),
    ).toThrow('Request failed with response: {"failure":{"id":"abc123"}}');
  });

  it("unwrapBody gives explicit context when an error body is empty", () => {
    expect(() =>
      unwrapBody({
        response: new Response(null, {
          status: 502,
          statusText: "Bad Gateway",
        }),
      }),
    ).toThrow("Request failed with 502 Bad Gateway and no error body");
  });
});

describe("retryUnavailableReads", () => {
  const unavailable = (retryAfter: string | null) =>
    new Response(JSON.stringify({ success: false, error: "busy" }), {
      status: 503,
      headers: retryAfter ? { "Retry-After": retryAfter } : {},
    });
  const ok = () =>
    new Response(JSON.stringify({ success: true }), { status: 200 });

  it("asks a read again after Retry-After, then answers its data", async () => {
    const fetchMock = vi
      .fn<(req: Request) => Promise<Response>>()
      .mockResolvedValueOnce(unavailable("2"))
      .mockResolvedValueOnce(ok());
    const sleep = vi.fn(async () => undefined);
    const fetcher = retryUnavailableReads(
      fetchMock as unknown as typeof fetch,
      sleep,
      () => 0.5,
    );
    const res = await fetcher("https://test.local/api/x");
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // Retry-After plus jitter (half of the 1 s range here).
    expect(sleep).toHaveBeenCalledWith(2500, expect.any(AbortSignal));
  });

  it("does not retry a pool-full refusal that already waited for a slot", async () => {
    const waited = new Response("{}", {
      status: 503,
      headers: { "Retry-After": "2", [POOL_WAITED_HEADER]: "10000" },
    });
    const fetchMock = vi.fn(async () => waited);
    const fetcher = retryUnavailableReads(
      fetchMock as unknown as typeof fetch,
      async () => undefined,
    );
    expect((await fetcher("https://test.local/api/x")).status).toBe(503);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("stops waiting when the request is aborted", async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn(async () => unavailable("2"));
      const fetcher = retryUnavailableReads(
        fetchMock as unknown as typeof fetch,
      );
      const controller = new AbortController();
      const pending = fetcher("https://test.local/api/x", {
        signal: controller.signal,
      });
      const outcome = pending.then(
        () => "resolved",
        (e: unknown) => (e as Error).name,
      );
      await vi.advanceTimersByTimeAsync(100);
      controller.abort();
      expect(await outcome).toBe("AbortError");
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives up after the retries and returns the 503", async () => {
    const fetchMock = vi.fn(async () => unavailable("1"));
    const fetcher = retryUnavailableReads(
      fetchMock as unknown as typeof fetch,
      async () => undefined,
    );
    const res = await fetcher("https://test.local/api/x");
    expect(res.status).toBe(503);
    expect(fetchMock).toHaveBeenCalledTimes(1 + UNAVAILABLE_READ_RETRIES);
  });

  it("never retries a write, a 503 without Retry-After, or another status", async () => {
    for (const [init, response] of [
      [{ method: "POST", body: "{}" }, unavailable("1")],
      [{}, unavailable(null)],
      [{}, unavailable("30")],
      [{}, new Response("", { status: 500, headers: { "Retry-After": "1" } })],
    ] as const) {
      const fetchMock = vi.fn(async () => response.clone());
      const fetcher = retryUnavailableReads(
        fetchMock as unknown as typeof fetch,
        async () => undefined,
      );
      await fetcher("https://test.local/api/x", init);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  });

  it("is on the typed client: a run list read survives one 503", async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi
        .fn<(req: Request) => Promise<Response>>()
        .mockResolvedValueOnce(unavailable("1"))
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ success: true, runs: [] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        );
      const client = createApiClient(
        "https://test.local",
        fetchMock as unknown as typeof fetch,
      );
      const pending = client.GET(
        "/api/workspaces/{workspaceId}/workflows/{name}/runs",
        { params: { path: { workspaceId: "ws", name: "wf" } } },
      );
      await vi.advanceTimersByTimeAsync(2000);
      const { response } = await pending;
      expect(response.status).toBe(200);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
