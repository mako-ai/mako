/**
 * Message sanitizer tests.
 *
 * Focus: repairing persisted tool parts whose `input` is not a JSON object
 * before they reach `convertToModelMessages`. Anthropic rejects a replayed
 * `tool_use` whose input is a string/missing with
 * "messages.N.content.M.tool_use.input: Input should be a valid dictionary"
 * — reproduced live with the Close CRM MCP tools when the model emitted
 * malformed tool-call JSON (AI SDK keeps the raw text on `rawInput`).
 *
 * Run: tsx src/utils/message-sanitizer.test.ts
 */
import assert from "node:assert/strict";
import { convertToModelMessages, type UIMessage } from "ai";
import { sanitizeMessagesForModel } from "./message-sanitizer";

type LoosePart = Record<string, unknown>;

function assistantMessage(parts: LoosePart[]): UIMessage {
  return { id: "a1", role: "assistant", parts } as unknown as UIMessage;
}

function userMessage(text: string, id = "u1"): UIMessage {
  return { id, role: "user", parts: [{ type: "text", text }] } as UIMessage;
}

function firstToolPart(msg: UIMessage): LoosePart {
  const part = (msg.parts as unknown as LoosePart[]).find(
    p => p.type === "dynamic-tool" || String(p.type).startsWith("tool-"),
  );
  assert.ok(part, "expected a tool part");
  return part;
}

function testStringRawInputIsRepaired() {
  // Invalid tool call: the model emitted truncated JSON. AI SDK leaves
  // `input` undefined and stores the raw text on `rawInput` — which
  // convertToModelMessages forwards verbatim for output-error parts.
  const sanitized = sanitizeMessagesForModel([
    userMessage("search leads"),
    assistantMessage([
      {
        type: "dynamic-tool",
        toolName: "mcp_close_crm_lead_search",
        toolCallId: "call_1",
        state: "output-error",
        rawInput: '{"query": "name:Acme', // truncated → unparseable
        errorText: "Invalid tool input",
      },
    ]),
  ]);

  const part = firstToolPart(sanitized[1]);
  assert.deepEqual(part.input, {});
  assert.equal(part.rawInput, undefined);
}

function testParseableStringInputIsRecovered() {
  const sanitized = sanitizeMessagesForModel([
    userMessage("fetch lead"),
    assistantMessage([
      {
        type: "dynamic-tool",
        toolName: "mcp_close_crm_fetch_lead",
        toolCallId: "call_2",
        state: "output-available",
        input: '{"id":"lead_123"}', // stringified instead of parsed
        output: "Lead: Acme Robotics",
      },
    ]),
  ]);

  const part = firstToolPart(sanitized[1]);
  assert.deepEqual(part.input, { id: "lead_123" });
}

function testUndefinedInputBecomesEmptyObject() {
  // Zero-argument tools (e.g. Close's org_info) can persist with no input.
  const sanitized = sanitizeMessagesForModel([
    userMessage("org info"),
    assistantMessage([
      {
        type: "dynamic-tool",
        toolName: "mcp_close_crm_org_info",
        toolCallId: "call_3",
        state: "output-available",
        output: "Org: Mako Demo Org",
      },
    ]),
  ]);

  const part = firstToolPart(sanitized[1]);
  assert.deepEqual(part.input, {});
}

function testObjectInputIsPreserved() {
  const input = { id: "lead_123", description: "Robotics leader" };
  const sanitized = sanitizeMessagesForModel([
    userMessage("update lead"),
    assistantMessage([
      {
        type: "dynamic-tool",
        toolName: "mcp_close_crm_update_lead",
        toolCallId: "call_4",
        state: "output-available",
        input,
        output: "Updated",
      },
    ]),
  ]);

  const part = firstToolPart(sanitized[1]);
  assert.deepEqual(part.input, input);
}

function testLegacyErrorStateStillRepairsInput() {
  const sanitized = sanitizeMessagesForModel([
    userMessage("create lead"),
    assistantMessage([
      {
        type: "dynamic-tool",
        toolName: "mcp_close_crm_create_lead",
        toolCallId: "call_5",
        state: "error", // legacy client normalization
        input: "not json at all",
        output: { success: false, error: "Interrupted" },
      },
    ]),
  ]);

  const part = firstToolPart(sanitized[1]);
  assert.equal(part.state, "output-error");
  assert.equal(part.errorText, "Interrupted");
  assert.deepEqual(part.input, {});
  assert.equal(part.output, undefined);
}

async function testConvertedToolCallsAlwaysHaveObjectInput() {
  // End-to-end through the real AI SDK conversion: every tool-call the
  // provider will see must carry a plain-object input.
  const sanitized = sanitizeMessagesForModel([
    userMessage("do things"),
    assistantMessage([
      { type: "step-start" },
      {
        type: "dynamic-tool",
        toolName: "mcp_close_crm_lead_search",
        toolCallId: "call_a",
        state: "output-error",
        rawInput: '{"query": "name:Acme',
        errorText: "Invalid tool input",
      },
      {
        type: "dynamic-tool",
        toolName: "mcp_close_crm_org_info",
        toolCallId: "call_b",
        state: "output-available",
        output: "Org info",
      },
    ]),
    userMessage("continue", "u2"),
  ]);

  const modelMessages = await convertToModelMessages(sanitized);
  const toolCalls = modelMessages
    .flatMap(m => (Array.isArray(m.content) ? m.content : []))
    .filter(
      (c): c is { type: "tool-call"; input: unknown } =>
        (c as { type?: string }).type === "tool-call",
    );
  assert.equal(toolCalls.length, 2);
  for (const call of toolCalls) {
    assert.equal(
      typeof call.input === "object" &&
        call.input !== null &&
        !Array.isArray(call.input),
      true,
      `tool-call input must be a plain object, got: ${JSON.stringify(call.input)}`,
    );
  }
}

async function main() {
  testStringRawInputIsRepaired();
  testParseableStringInputIsRecovered();
  testUndefinedInputBecomesEmptyObject();
  testObjectInputIsPreserved();
  testLegacyErrorStateStillRepairsInput();
  await testConvertedToolCallsAlwaysHaveObjectInput();
  // eslint-disable-next-line no-console
  console.log("message-sanitizer tests passed");
}

void main();
