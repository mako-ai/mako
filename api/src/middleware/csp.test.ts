import { Hono } from "hono";
import { afterEach, expect, it } from "vitest";
import { SPA_CONTENT_SECURITY_POLICY, spaCspMiddleware } from "./csp";

const app = new Hono()
  .use("*", spaCspMiddleware)
  .get("/", c => c.html("<!doctype html><p>app</p>"))
  .get("/api/x", c => c.json({ ok: true }))
  .get("/own", c => {
    c.header("Content-Security-Policy", "frame-ancestors 'none'");
    return c.html("<p>sandboxed</p>");
  });

afterEach(() => {
  delete process.env.CONTENT_SECURITY_POLICY_MODE;
});

it("puts a report-only policy on HTML by default, and only on HTML", async () => {
  const html = await app.request("/");
  expect(html.headers.get("content-security-policy-report-only")).toBe(
    SPA_CONTENT_SECURITY_POLICY,
  );
  expect(html.headers.get("content-security-policy")).toBeNull();
  const json = await app.request("/api/x");
  expect(json.headers.get("content-security-policy-report-only")).toBeNull();
});

it("never overrides a response's own policy", async () => {
  const res = await app.request("/own");
  expect(res.headers.get("content-security-policy")).toBe(
    "frame-ancestors 'none'",
  );
  expect(res.headers.get("content-security-policy-report-only")).toBeNull();
});

it("enforce and off modes", async () => {
  process.env.CONTENT_SECURITY_POLICY_MODE = "enforce";
  expect((await app.request("/")).headers.get("content-security-policy")).toBe(
    SPA_CONTENT_SECURITY_POLICY,
  );
  process.env.CONTENT_SECURITY_POLICY_MODE = "off";
  const off = await app.request("/");
  expect(off.headers.get("content-security-policy")).toBeNull();
  expect(off.headers.get("content-security-policy-report-only")).toBeNull();
});
