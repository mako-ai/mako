/**
 * The OAuth discovery documents name the issuer and every endpoint an MCP
 * client sends the user to, so their origin must never come from a header a
 * client can forge.
 */
import { afterEach, beforeEach, expect, it } from "vitest";
import { isOwnRunAppHost, mcpOAuthWellKnownRoutes } from "./mcp-oauth.routes";

const saved = { ...process.env };
beforeEach(() => {
  delete process.env.PUBLIC_URL;
  delete process.env.CLIENT_URL;
  delete process.env.BASE_URL;
  delete process.env.K_SERVICE;
});
afterEach(() => {
  process.env = { ...saved };
});

async function issuer(url: string, headers: Record<string, string> = {}) {
  const res = await mcpOAuthWellKnownRoutes.request(
    new URL("/.well-known/oauth-authorization-server", url).toString(),
    { headers },
  );
  return ((await res.json()) as { issuer: string }).issuer;
}

it("ignores a forged x-forwarded-host, configured or not", async () => {
  process.env.PUBLIC_URL = "https://app.mako.ai/";
  expect(
    await issuer("https://app.mako.ai", {
      "x-forwarded-host": "attacker.example",
    }),
  ).toBe("https://app.mako.ai");
  // Even a forged *.run.app forwarded host is not honoured.
  expect(
    await issuer("https://app.mako.ai", {
      "x-forwarded-host": "evil-abc.a.run.app",
    }),
  ).toBe("https://app.mako.ai");

  delete process.env.PUBLIC_URL;
  expect(
    await issuer("http://localhost:8080", {
      "x-forwarded-host": "attacker.example",
    }),
  ).toBe("http://localhost:8080");
});

it("falls back to BASE_URL when PUBLIC_URL and CLIENT_URL are unset", async () => {
  process.env.BASE_URL = "https://pr-12.mako.ai";
  expect(await issuer("https://pr-12.mako.ai")).toBe("https://pr-12.mako.ai");
});

it("keeps self-referential metadata on this service's own run.app host", async () => {
  process.env.PUBLIC_URL = "https://app.mako.ai";
  process.env.K_SERVICE = "mako-pr-12";
  expect(await issuer("http://mako-pr-12-abc123-ew.a.run.app")).toBe(
    "https://mako-pr-12-abc123-ew.a.run.app",
  );
  expect(isOwnRunAppHost("other-svc-abc123-ew.a.run.app")).toBe(false);
  expect(isOwnRunAppHost("mako-pr-12-abc.a.run.app:443")).toBe(true);
  expect(isOwnRunAppHost("app.mako.ai")).toBe(false);
});

it("uses the configured URL when the edge proxied the request to run.app", async () => {
  // The app-router Worker rewrites Host to the run.app origin and sets
  // X-Forwarded-Host; the public host must still win.
  process.env.BASE_URL = "https://app.mako.ai";
  process.env.K_SERVICE = "mako";
  expect(
    await issuer("https://mako-4vn6jszboq-ew.a.run.app", {
      "x-forwarded-host": "app.mako.ai",
    }),
  ).toBe("https://app.mako.ai");
  // A forged forwarded host on a direct hit yields the canonical origin too.
  expect(
    await issuer("https://mako-4vn6jszboq-ew.a.run.app", {
      "x-forwarded-host": "attacker.example",
    }),
  ).toBe("https://app.mako.ai");
  // A direct hit still gets self-referential metadata.
  expect(await issuer("https://mako-4vn6jszboq-ew.a.run.app")).toBe(
    "https://mako-4vn6jszboq-ew.a.run.app",
  );
});
