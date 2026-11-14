import { Hono } from "hono";
import { afterEach, expect, it } from "vitest";
import { clientIp, isLoopbackAddress } from "./client-ip";

const app = new Hono().get("/", c => c.text(clientIp(c)));
const ipFor = async (headers: Record<string, string>) =>
  (await app.request("/", { headers })).text();

afterEach(() => {
  delete process.env.TRUSTED_PROXY_HOPS;
});

it("prefers cf-connecting-ip (rewritten by the edge)", async () => {
  expect(
    await ipFor({
      "cf-connecting-ip": "203.0.113.1",
      "x-forwarded-for": "1.1.1.1, 2.2.2.2",
    }),
  ).toBe("203.0.113.1");
});

it("reads x-forwarded-for from the proxy-appended end, not the client-typed start", async () => {
  expect(await ipFor({ "x-forwarded-for": "6.6.6.6, 203.0.113.7" })).toBe(
    "203.0.113.7",
  );
  process.env.TRUSTED_PROXY_HOPS = "2";
  expect(
    await ipFor({ "x-forwarded-for": "6.6.6.6, 203.0.113.7, 10.0.0.1" }),
  ).toBe("203.0.113.7");
  // A chain shorter than the configured hops falls back to its first entry.
  expect(await ipFor({ "x-forwarded-for": "203.0.113.8" })).toBe("203.0.113.8");
  // Zero hops: the header is not trusted at all.
  process.env.TRUSTED_PROXY_HOPS = "0";
  expect(await ipFor({ "x-forwarded-for": "6.6.6.6" })).toBe("unknown");
});

it("falls back to unknown without headers or a socket", async () => {
  expect(await ipFor({})).toBe("unknown");
});

it("recognises loopback peers only", () => {
  for (const a of ["127.0.0.1", "127.1.2.3", "::1", "::ffff:127.0.0.1"]) {
    expect(isLoopbackAddress(a)).toBe(true);
  }
  for (const a of [
    "10.0.0.1",
    "::ffff:10.0.0.1",
    "1127.0.0.1",
    "",
    undefined,
  ]) {
    expect(isLoopbackAddress(a)).toBe(false);
  }
});
