import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { probeMakoMcpHttp } from "./mcp-probe";

describe("probeMakoMcpHttp", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("resolves when initialize returns 200", async () => {
    globalThis.fetch = (async () =>
      new Response("{}", { status: 200 })) as typeof fetch;
    await probeMakoMcpHttp({
      mcpUrl: "http://127.0.0.1:8080/api/mcp",
      authorization: "Bearer tok",
    });
  });

  it("throws a clear auth error on 401", async () => {
    globalThis.fetch = (async () =>
      new Response("unauthorized", { status: 401 })) as typeof fetch;
    await assert.rejects(
      () =>
        probeMakoMcpHttp({
          mcpUrl: "http://127.0.0.1:8080/api/mcp",
          authorization: "Bearer bad",
        }),
      /auth failed/i,
    );
  });
});
