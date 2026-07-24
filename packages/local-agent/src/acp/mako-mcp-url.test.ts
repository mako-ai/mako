import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assertAllowedMakoMcpUrl } from "./mako-mcp-url";

describe("assertAllowedMakoMcpUrl", () => {
  it("allows trusted Mako API hosts", () => {
    assert.equal(
      assertAllowedMakoMcpUrl("https://app.mako.ai/api/mcp"),
      "https://app.mako.ai/api/mcp",
    );
    assert.equal(
      assertAllowedMakoMcpUrl("http://127.0.0.1:8080/api/mcp"),
      "http://127.0.0.1:8080/api/mcp",
    );
    assert.equal(
      assertAllowedMakoMcpUrl("https://pr-739.mako.ai/api/mcp/"),
      "https://pr-739.mako.ai/api/mcp",
    );
    assert.equal(
      assertAllowedMakoMcpUrl(
        "https://mako-pr-739-zmonogxw7a-ew.a.run.app/api/mcp",
      ),
      "https://mako-pr-739-zmonogxw7a-ew.a.run.app/api/mcp",
    );
  });

  it("rejects attacker-controlled hosts and wrong paths", () => {
    assert.throws(
      () => assertAllowedMakoMcpUrl("https://example.com/api/mcp"),
      /not allowed/i,
    );
    assert.throws(
      () => assertAllowedMakoMcpUrl("https://app.mako.ai/api/other"),
      /\/api\/mcp/i,
    );
    assert.throws(
      () => assertAllowedMakoMcpUrl("http://evil.com/api/mcp"),
      /localhost|not allowed/i,
    );
    assert.throws(
      () =>
        assertAllowedMakoMcpUrl("https://user:pass@app.mako.ai/api/mcp"),
      /credentials/i,
    );
  });
});
