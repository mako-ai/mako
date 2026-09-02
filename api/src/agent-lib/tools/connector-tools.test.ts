/**
 * `probe_connector`: wired, classified, gated, and honest at the edge.
 *
 * WIRING — registered by the in-product agent, classified in the bridge
 * policy, present in the inventory the policy tests walk, deferred (loaded on
 * demand) rather than in every prompt, and read-only for the plan gate.
 *
 * GATING — it reads data from a platform outside the workspace, so it is
 * hidden from an MCP credential without query access, exactly like
 * `sql_execute_query`; discovery (`list_connectors`) stays visible.
 *
 * EDGE — the tool never throws: a caller mistake comes back as `{ error,
 * code }` and an invalid `since` is refused before the service is called.
 * The service itself is mocked here; its own promises are pinned in
 * `connectors/probe.service.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Types } from "mongoose";

const state = vi.hoisted(() => ({
  calls: [] as unknown[],
  next: null as unknown,
}));

vi.mock("../../connectors/probe.service", async importOriginal => {
  const actual =
    await importOriginal<typeof import("../../connectors/probe.service")>();
  return {
    ...actual,
    probeConnector: vi.fn(async (input: unknown) => {
      state.calls.push(input);
      if (state.next instanceof Error) throw state.next;
      return state.next;
    }),
  };
});

import { ProbeError } from "../../connectors/probe.service";
import { createConnectorTools } from "./connector-tools";
import { buildMakoMcpToolset } from "../../mcp/mako-mcp-server";
import {
  MCP_BRIDGE_POLICY,
  assertBridgePolicyCovers,
  assertBridgePolicyNotStale,
  mcpExposedToolNames,
  mcpOpenWorldHint,
  mcpReadOnlyHint,
} from "../../mcp/bridge-policy";
import { collectLiveAgentToolNames } from "../../mcp/bridge-inventory";
import { DEFERRED_BUILTIN_TOOL_NAMES } from "../../agents/modes/registry";
import { unifiedAgentFactory } from "../../agents/unified";
import { READ_ONLY_TOOL_NAMES } from "@mako/agent-tools";
import type { AgentContext } from "../../agents/types";

process.env.ENCRYPTION_KEY =
  process.env.ENCRYPTION_KEY ??
  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

const WS = new Types.ObjectId().toString();
const CONNECTOR = new Types.ObjectId().toString();

type Executable = {
  execute: (input: unknown) => Promise<Record<string, unknown>>;
};

function toolsetFor(scopes: string[]): Record<string, unknown> {
  return buildMakoMcpToolset({
    workspaceId: WS,
    scopes,
  } as Parameters<typeof buildMakoMcpToolset>[0]);
}

beforeEach(() => {
  state.calls = [];
  state.next = {
    connector: { id: CONNECTOR, name: "Vercel", type: "ws:vercel-ai-gateway" },
    check: { success: true, message: "ok" },
    durationMs: 1,
  };
});

describe("wiring: registered, classified, deferred, read-only", () => {
  it("is classified everywhere a built-in tool must be", () => {
    const entry = MCP_BRIDGE_POLICY.probe_connector;
    expect(entry?.status).toBe("bridge");
    expect(
      entry && "requiresQueryAccess" in entry && entry.requiresQueryAccess,
    ).toBe(true);
    expect(mcpOpenWorldHint("probe_connector")).toBe(true);
    expect(mcpExposedToolNames()).toContain("probe_connector");
    assertBridgePolicyCovers(collectLiveAgentToolNames());
    assertBridgePolicyNotStale(collectLiveAgentToolNames());
    expect(collectLiveAgentToolNames()).toContain("probe_connector");
    for (const name of [
      "list_connectors",
      "inspect_connector",
      "probe_connector",
    ]) {
      expect(DEFERRED_BUILTIN_TOOL_NAMES).toContain(name);
      expect(READ_ONLY_TOOL_NAMES.has(name)).toBe(true);
      expect(mcpReadOnlyHint(name, "read")).toBe(true);
    }
  });

  it("is registered by the in-product agent factory, with its discovery pair", () => {
    const tools = unifiedAgentFactory({
      workspaceId: WS,
      userId: "u1",
      consoles: [],
    } as unknown as AgentContext).tools;
    const names = Object.keys(tools);
    expect(names).toContain("list_connectors");
    expect(names).toContain("inspect_connector");
    expect(names).toContain("probe_connector");
  });

  it("exposes exactly the three connector tools from its factory", () => {
    expect(Object.keys(createConnectorTools(WS)).sort()).toEqual([
      "inspect_connector",
      "list_connectors",
      "probe_connector",
    ]);
  });
});

describe("gating: a live read needs query access", () => {
  it("is hidden from a key without query:read while discovery stays", () => {
    const without = toolsetFor(["mcp"]);
    expect(without.list_connectors).toBeTruthy();
    expect(without.inspect_connector).toBeTruthy();
    expect(without.probe_connector).toBeUndefined();

    const withRead = toolsetFor(["mcp", "query:read"]);
    expect(withRead.probe_connector).toBeTruthy();
  });
});

describe("edge: the tool never throws", () => {
  const exposed = () =>
    toolsetFor(["mcp", "query:read"]).probe_connector as Executable;

  it("hands a valid call to the service with the workspace bound", async () => {
    const result = await exposed().execute({
      connectorId: CONNECTOR,
      entity: "daily-usage",
      limit: 5,
      fields: ["day"],
      since: "2026-08-01T00:00:00Z",
    });
    expect(result.check).toEqual({ success: true, message: "ok" });
    expect(state.calls).toEqual([
      {
        workspaceId: WS,
        connectorId: CONNECTOR,
        entity: "daily-usage",
        limit: 5,
        fields: ["day"],
        since: new Date("2026-08-01T00:00:00Z"),
      },
    ]);
  });

  it("refuses an unparseable `since` before calling the service", async () => {
    const result = await exposed().execute({
      connectorId: CONNECTOR,
      since: "last tuesday",
    });
    expect(result.error).toMatch(/not a valid ISO 8601/);
    expect(state.calls).toEqual([]);
  });

  it("returns a ProbeError as { error, code }", async () => {
    state.next = new ProbeError("unknown_entity", "no such entity");
    const result = await exposed().execute({
      connectorId: CONNECTOR,
      entity: "nope",
    });
    expect(result).toEqual({ error: "no such entity", code: "unknown_entity" });
  });

  it("wraps any other failure without a code", async () => {
    state.next = new Error("boom");
    const result = await exposed().execute({ connectorId: CONNECTOR });
    expect(result).toEqual({ error: "Probe failed: boom" });
  });
});
