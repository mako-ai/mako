// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAKO_MCP_TOKEN_TTL_MS,
  MAKO_MCP_TOKEN_REUSE_MARGIN_MS,
  isMakoMcpTokenStale,
  makoMcpTokenExpiresAtMs,
} from "./acp-session-expiry";

const NOW = Date.parse("2026-09-03T10:00:00.000Z");
const HOUR = 60 * 60 * 1000;

describe("isMakoMcpTokenStale", () => {
  it("ignores sessions without Mako MCP attached", () => {
    expect(
      isMakoMcpTokenStale(
        {
          makoMcpAttached: false,
          createdAt: new Date(NOW - 48 * HOUR).toISOString(),
        },
        NOW,
      ),
    ).toBe(false);
  });

  it("uses the explicit expiry when the session carries one", () => {
    const base = {
      makoMcpAttached: true,
      createdAt: new Date(NOW - 20 * HOUR).toISOString(),
    };
    expect(
      isMakoMcpTokenStale(
        { ...base, makoMcpTokenExpiresAt: new Date(NOW + HOUR).toISOString() },
        NOW,
      ),
    ).toBe(false);
    expect(
      isMakoMcpTokenStale(
        { ...base, makoMcpTokenExpiresAt: new Date(NOW - 1000).toISOString() },
        NOW,
      ),
    ).toBe(true);
  });

  it("treats a token inside the reuse margin as stale", () => {
    const soon = new Date(
      NOW + MAKO_MCP_TOKEN_REUSE_MARGIN_MS - 1000,
    ).toISOString();
    expect(
      isMakoMcpTokenStale(
        { makoMcpAttached: true, createdAt: "", makoMcpTokenExpiresAt: soon },
        NOW,
      ),
    ).toBe(true);
  });

  it("falls back to createdAt + default TTL for older Local Agents", () => {
    const createdAt = new Date(NOW - 2 * HOUR).toISOString();
    expect(makoMcpTokenExpiresAtMs({ makoMcpAttached: true, createdAt })).toBe(
      NOW - 2 * HOUR + DEFAULT_MAKO_MCP_TOKEN_TTL_MS,
    );
    expect(isMakoMcpTokenStale({ makoMcpAttached: true, createdAt }, NOW)).toBe(
      false,
    );
    expect(
      isMakoMcpTokenStale(
        {
          makoMcpAttached: true,
          createdAt: new Date(NOW - 9 * HOUR).toISOString(),
        },
        NOW,
      ),
    ).toBe(true);
  });

  it("never marks a session stale when no expiry can be derived", () => {
    expect(
      isMakoMcpTokenStale({ makoMcpAttached: true, createdAt: "garbage" }, NOW),
    ).toBe(false);
  });
});
