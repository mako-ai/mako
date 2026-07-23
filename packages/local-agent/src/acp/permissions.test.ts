import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isMakoMcpToolName,
  pickAllowOptionId,
  shouldAutoApprovePermission,
} from "./permissions";

describe("ACP permission auto-approve", () => {
  it("detects Claude MCP tool names for mako workspace", () => {
    assert.equal(
      isMakoMcpToolName("mcp__mako-workspace__list_connections"),
      true,
    );
    assert.equal(isMakoMcpToolName("mcp__mako__sql_execute_query"), true);
    assert.equal(isMakoMcpToolName("mcp__slack__post"), false);
    assert.equal(isMakoMcpToolName("Bash"), false);
  });

  it("prefers allow_always over allow_once", () => {
    assert.equal(
      pickAllowOptionId([
        { optionId: "once", kind: "allow_once" },
        { optionId: "always", kind: "allow_always" },
      ]),
      "always",
    );
  });

  it("auto-approves Mako MCP tools", () => {
    const decision = shouldAutoApprovePermission({
      toolCall: {
        name: "mcp__mako__list_connections",
        kind: "other",
      },
      options: [
        { optionId: "allow-once", kind: "allow_once" },
        { optionId: "reject-once", kind: "reject_once" },
      ],
    });
    assert.deepEqual(decision, { optionId: "allow-once" });
  });

  it("auto-approves read/search kinds", () => {
    const decision = shouldAutoApprovePermission({
      toolCall: { title: "Read package.json", kind: "read" },
      options: [{ optionId: "allow-once", kind: "allow_once" }],
    });
    assert.deepEqual(decision, { optionId: "allow-once" });
  });

  it("does not auto-approve bash/edit without Mako match", () => {
    assert.equal(
      shouldAutoApprovePermission({
        toolCall: { name: "Bash", kind: "execute" },
        options: [{ optionId: "allow-once", kind: "allow_once" }],
      }),
      null,
    );
  });
});
