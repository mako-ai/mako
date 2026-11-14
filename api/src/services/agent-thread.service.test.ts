import assert from "node:assert/strict";
import type { UIMessage } from "ai";
import { convertUIMessageToStoredFormat } from "./agent-thread.service";

const approval = { id: "approval-slack-1", approved: true };
const stored = convertUIMessageToStoredFormat({
  id: "assistant-1",
  role: "assistant",
  parts: [
    {
      type: "dynamic-tool",
      toolCallId: "call-slack-1",
      toolName: "mcp_slack_search",
      state: "approval-responded",
      input: { query: "incident" },
      approval,
      callProviderMetadata: { provider: "gateway" },
    },
  ],
} as unknown as UIMessage);

// Stored parts are loosely typed; this test is about the fields below.
const part = stored.parts[0] as unknown as Record<string, unknown>;
assert.deepEqual(part.approval, approval);
assert.equal(part.state, "approval-responded");
assert.equal(part.toolCallId, "call-slack-1");
assert.equal(Object.prototype.hasOwnProperty.call(part, "output"), false);
assert.deepEqual(part.callProviderMetadata, { provider: "gateway" });

process.stdout.write(
  "✓ agent-thread.service approval persistence tests passed\n",
);
