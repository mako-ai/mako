/**
 * Minimal stateless MCP (JSON-RPC) server for Desktop-only tools.
 * Claude ACP attaches this as `mako-desktop` over loopback HTTP.
 */
import {
  HITL_TOOL_JSON_SCHEMAS,
  validateHitlToolArguments,
} from "@mako/agent-tools";

import {
  desktopBridgeRegistry,
  isDesktopHitlTool,
  type DesktopBridgeToolName,
} from "./registry";

const SERVER_NAME = "mako-desktop";
const SERVER_VERSION = "0.3.0";
const PROTOCOL_VERSION = "2024-11-05";

type JsonRpcId = string | number | null;

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: JsonRpcId;
  method?: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: { code: number; message: string };
}

const TOOLS: Array<{
  name: DesktopBridgeToolName;
  description: string;
  inputSchema: Record<string, unknown>;
}> = [
  {
    name: "run_app",
    description:
      "Rebuild the in-Desktop app preview iframe and return live build/runtime errors (previewErrors). Pass rebuild: false to read the current previewErrors without forcing a rebuild. Prefer this over create_preview_token when Chat is open in Mako Desktop.",
    inputSchema: {
      type: "object",
      properties: {
        appId: { type: "string", description: "App id to preview" },
        rebuild: {
          type: "boolean",
          description:
            "Default true. false = return current previewErrors without rebuilding the iframe.",
        },
      },
      required: ["appId"],
    },
  },
  {
    name: "list_open_consoles",
    description:
      "List consoles currently open as tabs in Mako Desktop Chat (id, title, connection). Prefer these ids when the user says “this console”.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    // Schemas are single-sourced from @mako/agent-tools (same zod
    // definitions the in-app agent uses); only the description is
    // Desktop-tailored.
    name: "ask_clarifying_questions",
    description:
      "Pause and show clarifying questions in the Mako Chat dock (same UI as the in-app agent). Use this instead of asking questions as plain text. Returns the user's answers.",
    inputSchema: HITL_TOOL_JSON_SCHEMAS.ask_clarifying_questions,
  },
  {
    name: "submit_plan",
    description:
      "Present a reviewable plan in the Mako Chat dock for Approve / Request changes / Cancel. Use before large, destructive, or multi-step work. Include only the requiredCapabilities visibly described by the plan — approval grants exactly those. Returns the user's decision.",
    inputSchema: HITL_TOOL_JSON_SCHEMAS.submit_plan,
  },
];

const TOOL_NAMES = new Set(TOOLS.map(t => t.name));

function ok(id: JsonRpcId, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

function fail(id: JsonRpcId, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

async function callTool(
  rawName: string,
  rawArgs: Record<string, unknown>,
  context?: { agentSessionId?: string; workspaceId?: string },
): Promise<{ text: string; isError?: boolean }> {
  // Legacy alias from pre-0.3 tool lists: agents mid-session across an
  // update may still call it — same job as run_app({ rebuild: false }).
  const legacyPreviewErrors = rawName === "get_preview_errors";
  const name = legacyPreviewErrors ? "run_app" : rawName;
  let args = legacyPreviewErrors ? { ...rawArgs, rebuild: false } : rawArgs;
  if (!TOOL_NAMES.has(name as DesktopBridgeToolName)) {
    return { text: `Unknown tool: ${name}`, isError: true };
  }
  // HITL payloads render directly in the Desktop dock — bounce malformed
  // arguments back to the agent as a correctable tool error instead of
  // forwarding a shape the renderer cannot display.
  if (isDesktopHitlTool(name)) {
    const validated = validateHitlToolArguments(name, args);
    if (!validated.ok) {
      return { text: validated.error, isError: true };
    }
    args = validated.data;
  }
  try {
    const result = await desktopBridgeRegistry.enqueue(
      name as DesktopBridgeToolName,
      args && typeof args === "object" ? args : {},
      undefined,
      context,
    );
    return {
      text: typeof result === "string" ? result : JSON.stringify(result),
    };
  } catch (error) {
    return {
      text: error instanceof Error ? error.message : String(error),
      isError: true,
    };
  }
}

async function handleOne(
  message: JsonRpcRequest,
  context?: { agentSessionId?: string; workspaceId?: string },
): Promise<JsonRpcResponse | null> {
  const id = message.id ?? null;
  const method = message.method;

  // Notifications have no id / no response.
  if (method?.startsWith("notifications/")) {
    return null;
  }

  if (method === "initialize") {
    return ok(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      instructions:
        "Desktop tools for Mako Chat: run_app / preview errors, list_open_consoles, and interactive ask_clarifying_questions / submit_plan (docked cards).",
    });
  }

  if (method === "ping") {
    return ok(id, {});
  }

  if (method === "tools/list") {
    return ok(id, { tools: TOOLS });
  }

  if (method === "tools/call") {
    const params = message.params || {};
    const name = String(params.name || "");
    const args =
      params.arguments && typeof params.arguments === "object"
        ? (params.arguments as Record<string, unknown>)
        : {};
    // HITL tools block the HTTP exchange until Desktop completes — expected.
    // get_preview_errors is a legacy alias resolved inside callTool.
    if (
      isDesktopHitlTool(name) ||
      TOOL_NAMES.has(name as DesktopBridgeToolName) ||
      name === "get_preview_errors"
    ) {
      const result = await callTool(name, args, context);
      return ok(id, {
        content: [{ type: "text", text: result.text }],
        ...(result.isError ? { isError: true } : {}),
      });
    }
    return ok(id, {
      content: [{ type: "text", text: `Unknown tool: ${name}` }],
      isError: true,
    });
  }

  if (id === null) return null;
  return fail(id, -32601, `Method not found: ${method || "(missing)"}`);
}

export async function handleDesktopMcpExchange(
  body: unknown,
  context?: { agentSessionId?: string; workspaceId?: string },
): Promise<{ status: 200 | 202 | 400; body: unknown }> {
  const incoming = Array.isArray(body) ? body : [body];
  if (
    incoming.length === 0 ||
    !incoming.every(
      m => m && typeof m === "object" && (m as JsonRpcRequest).jsonrpc === "2.0",
    )
  ) {
    return {
      status: 400,
      body: {
        jsonrpc: "2.0",
        id: null,
        error: {
          code: -32600,
          message: "Invalid Request: expected JSON-RPC 2.0",
        },
      },
    };
  }

  const responses: JsonRpcResponse[] = [];
  for (const message of incoming) {
    const response = await handleOne(message as JsonRpcRequest, context);
    if (response) responses.push(response);
  }

  if (responses.length === 0) {
    return { status: 202, body: null };
  }
  return {
    status: 200,
    body: Array.isArray(body) ? responses : responses[0],
  };
}

export const DESKTOP_MCP_PATH = "/desktop/mcp";
export const DESKTOP_MCP_SERVER_NAME = SERVER_NAME;
