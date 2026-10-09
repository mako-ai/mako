/**
 * The browser pages of the MCP sign-in: the consent screen and its error
 * pages, and their design parity with the `mako login` loopback page.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AUTH_PAGE_TOKENS, authMessagePage } from "./auth-page";
import { consentPage, describeRedirect } from "./mcp-consent-page";
import { parseMcpOAuthScopes } from "./mcp-oauth.service";

const WORKSPACES = [
  { id: "ws1", name: "RealAdvisor", role: "owner" },
  { id: "ws2", name: "Demo", role: "member" },
];

/** The consent page for an authorize URL's `scope` parameter, as the route builds it. */
function consentFor(scope: string | undefined, clientName = "Mako CLI") {
  return consentPage({
    clientName,
    params: {
      clientId: "mcpc_1",
      redirectUri: "http://127.0.0.1:53422/callback",
      state: "st",
      codeChallenge: "ch",
      scopes: parseMcpOAuthScopes(scope),
    },
    workspaces: WORKSPACES,
  });
}

const ALL_SCOPES = "mcp query:read warehouse:write connections:write";

describe("MCP consent page", () => {
  // Connecting gives everything the person's role allows: no per-permission
  // checkbox, whatever the client asked for.
  it("has no permission checkboxes, whatever was requested", () => {
    for (const scope of [
      undefined,
      "mcp query:read",
      "mcp query:read warehouse:write",
      "connections:write",
      "offline_access",
    ]) {
      const html = consentFor(scope);
      expect(html).not.toMatch(/type="checkbox"/);
      expect(html).not.toContain("grant_warehouse_write");
      expect(html).toContain("Run dbt models and jobs in your warehouse");
      expect(html).toContain("Create source connections");
      expect(html).toContain("a viewer stays read-only");
    }
  });

  it("issues the full scope set on every grant", () => {
    for (const scope of [
      undefined,
      "mcp",
      "warehouse:write",
      "offline_access",
    ]) {
      expect(parseMcpOAuthScopes(scope).join(" ")).toBe(ALL_SCOPES);
    }
  });

  it("carries the flow's parameters through the form, unchanged", () => {
    const html = consentFor("mcp query:read");
    for (const [name, value] of [
      ["client_id", "mcpc_1"],
      ["redirect_uri", "http://127.0.0.1:53422/callback"],
      ["state", "st"],
      ["code_challenge", "ch"],
      ["scope", ALL_SCOPES],
    ]) {
      expect(html).toContain(
        `<input type="hidden" name="${name}" value="${value}" />`,
      );
    }
    expect(html).toContain('action="/api/oauth/mcp/authorize"');
    expect(html).toMatch(/name="workspace_id" value="ws1" checked/);
    expect(html).toContain('name="decision" value="deny"');
    expect(html).toContain('name="decision" value="allow"');
  });

  it("escapes the client's self-chosen name and workspace names", () => {
    const html = consentPage({
      clientName: '<img src=x onerror="alert(1)">',
      params: {
        clientId: "c",
        redirectUri: "https://evil.example/cb",
        codeChallenge: "x",
        scopes: parseMcpOAuthScopes(undefined),
      },
      workspaces: [{ id: '"><script>', name: "<b>WS</b>", role: "owner" }],
    });
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain('"><script>');
    expect(html).not.toContain("<b>WS</b>");
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
  });

  it("says where approving sends the browser", () => {
    expect(describeRedirect("http://127.0.0.1:53422/callback")).toBe(
      "127.0.0.1:53422 (this computer)",
    );
    expect(describeRedirect("https://claude.ai/api/mcp/auth_callback")).toBe(
      "claude.ai",
    );
    expect(describeRedirect("cursor://anysphere/oauth")).toBe(
      "cursor:// (an app on this computer)",
    );
  });
});

describe("MCP sign-in error pages", () => {
  it("render in the shared card, with the message escaped", () => {
    const html = authMessagePage({
      heading: "Can’t connect",
      message: "<script>x</script> is not registered",
      next: { title: "Start again", body: "Retry." },
    });
    expect(html).toContain('<main class="card">');
    expect(html).toContain("MAKO / CONNECT");
    expect(html).not.toContain("<script>x</script>");
    expect(html).toContain("&lt;script&gt;x&lt;/script&gt;");
  });
});

// The CLI's loopback page is published on its own and cannot import the
// API's styles; it carries a copy. Keep the two one design.
describe("design parity with the mako login page", () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, "../../../packages/cli/src/login-page.js"),
    "utf8",
  );

  function tokensIn(block: string): Record<string, string> {
    return Object.fromEntries(
      [...block.matchAll(/--([a-z-]+):\s*([^;]+);/g)].map(m => [
        m[1],
        m[2].trim(),
      ]),
    );
  }

  it("uses the same light and dark tokens", () => {
    const darkStart = source.indexOf("@media (prefers-color-scheme: dark)");
    expect(darkStart).toBeGreaterThan(0);
    const light = tokensIn(source.slice(source.indexOf(":root"), darkStart));
    const dark = tokensIn(
      source.slice(
        darkStart,
        source.indexOf("}", source.indexOf("}", darkStart) + 1),
      ),
    );
    expect(light).toEqual(AUTH_PAGE_TOKENS.light);
    expect(dark).toEqual(AUTH_PAGE_TOKENS.dark);
  });
});
