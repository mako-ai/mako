import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { __resetAuthRedirectState, handleUnauthorized } from "./auth-redirect";

/**
 * The deploy-resilient 401 handler: it must only redirect to /login when
 * `/auth/me` returns a definitive 401, and must stay put for transient
 * failures (network / 5xx) that happen during a rolling deploy.
 */

interface FakeLocation {
  pathname: string;
  href: string;
}

function stubBrowser(pathname = "/dashboard"): FakeLocation {
  const location: FakeLocation = { pathname, href: pathname };
  vi.stubGlobal("window", { location });
  vi.stubGlobal("localStorage", {
    getItem: vi.fn(),
    setItem: vi.fn(),
    removeItem: vi.fn(),
    clear: vi.fn(),
    key: vi.fn(),
    length: 0,
  } as unknown as Storage);
  return location;
}

function meResponse(status: number): Response {
  return new Response(status === 200 ? JSON.stringify({ user: {} }) : null, {
    status,
  });
}

describe("handleUnauthorized", () => {
  beforeEach(() => {
    __resetAuthRedirectState();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("redirects to /login when /auth/me confirms a dead session (401)", async () => {
    const location = stubBrowser();
    const fetchMock = vi.fn(async () => meResponse(401));
    vi.stubGlobal("fetch", fetchMock);

    await handleUnauthorized();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(location.href).toBe("/login");
  });

  it("does NOT redirect when /auth/me says the session is still alive", async () => {
    const location = stubBrowser();
    const fetchMock = vi.fn(async () => meResponse(200));
    vi.stubGlobal("fetch", fetchMock);

    await handleUnauthorized();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(location.href).toBe("/dashboard");
  });

  it("retries transient failures and stays put when undetermined (deploy blip)", async () => {
    const location = stubBrowser();
    // Network error, then 503, then 503 → never a definitive 401.
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValueOnce(meResponse(503))
      .mockResolvedValueOnce(meResponse(503));
    vi.stubGlobal("fetch", fetchMock);

    const done = handleUnauthorized();
    await vi.runAllTimersAsync();
    await done;

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(location.href).toBe("/dashboard");
  });

  it("recovers via a later attempt: 503 then alive → no redirect", async () => {
    const location = stubBrowser();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(meResponse(503))
      .mockResolvedValueOnce(meResponse(200));
    vi.stubGlobal("fetch", fetchMock);

    const done = handleUnauthorized();
    await vi.runAllTimersAsync();
    await done;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(location.href).toBe("/dashboard");
  });

  it("dedupes concurrent 401s into a single /auth/me probe", async () => {
    stubBrowser();
    const fetchMock = vi.fn(async () => meResponse(401));
    vi.stubGlobal("fetch", fetchMock);

    const a = handleUnauthorized();
    const b = handleUnauthorized();
    await Promise.all([a, b]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does nothing when already on the /login page", async () => {
    stubBrowser("/login");
    const fetchMock = vi.fn(async () => meResponse(401));
    vi.stubGlobal("fetch", fetchMock);

    await handleUnauthorized();

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
