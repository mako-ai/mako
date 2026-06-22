import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { exchangeInstallUserToken, userControlsInstallation } from "./app-auth";

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
  } as unknown as Response;
}

describe("exchangeInstallUserToken", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.stubEnv("GITHUB_APP_CLIENT_ID", "cid");
    vi.stubEnv("GITHUB_APP_CLIENT_SECRET", "csecret");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("returns the access token from a successful exchange", async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValue(jsonResponse({ access_token: "u-token" }));
    await expect(exchangeInstallUserToken("code123")).resolves.toBe("u-token");
  });

  it("throws when the OAuth client is not configured", async () => {
    vi.stubEnv("GITHUB_APP_CLIENT_ID", "");
    vi.stubEnv("GITHUB_APP_CLIENT_SECRET", "");
    await expect(exchangeInstallUserToken("code123")).rejects.toThrow(
      /not configured/i,
    );
  });

  it("throws when GitHub returns no token", async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValue(jsonResponse({ error: "bad_verification_code" }));
    await expect(exchangeInstallUserToken("code123")).rejects.toThrow(
      /no token/i,
    );
  });

  it("throws on a non-OK exchange response", async () => {
    global.fetch = vi.fn().mockResolvedValue(jsonResponse({}, false, 401));
    await expect(exchangeInstallUserToken("code123")).rejects.toThrow(/401/);
  });
});

describe("userControlsInstallation", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("returns true when the installation is in the user's list", async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ installations: [{ id: 1 }, { id: 42 }] }),
      );
    await expect(userControlsInstallation("u-token", 42)).resolves.toBe(true);
  });

  it("returns false when absent and the page is not full", async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValue(jsonResponse({ installations: [{ id: 1 }] }));
    await expect(userControlsInstallation("u-token", 999)).resolves.toBe(false);
  });

  it("paginates across full pages until the id is found", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({ id: i + 1 }));
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ installations: page1 }))
      .mockResolvedValueOnce(jsonResponse({ installations: [{ id: 777 }] }));
    global.fetch = fetchMock;
    await expect(userControlsInstallation("u-token", 777)).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("throws when the API call fails", async () => {
    global.fetch = vi.fn().mockResolvedValue(jsonResponse({}, false, 403));
    await expect(userControlsInstallation("u-token", 1)).rejects.toThrow(/403/);
  });
});
