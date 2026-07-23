import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { AcpSessionManager } from "./manager";
import type { AcpBridgeEvent } from "./types";

const mockAgentPath = path.join(__dirname, "mock-agent.ts");

describe("AcpSessionManager with mock agent", () => {
  const previous = {
    command: process.env.MAKO_ACP_AGENT_COMMAND,
    args: process.env.MAKO_ACP_AGENT_ARGS,
    provider: process.env.MAKO_ACP_PROVIDER,
  };

  let manager: AcpSessionManager;

  before(() => {
    process.env.MAKO_ACP_AGENT_COMMAND = "npx";
    process.env.MAKO_ACP_AGENT_ARGS = JSON.stringify([
      "tsx",
      mockAgentPath,
    ]);
    process.env.MAKO_ACP_PROVIDER = "claude";
    manager = new AcpSessionManager();
  });

  after(() => {
    manager.shutdown();
    if (previous.command === undefined) {
      delete process.env.MAKO_ACP_AGENT_COMMAND;
    } else {
      process.env.MAKO_ACP_AGENT_COMMAND = previous.command;
    }
    if (previous.args === undefined) {
      delete process.env.MAKO_ACP_AGENT_ARGS;
    } else {
      process.env.MAKO_ACP_AGENT_ARGS = previous.args;
    }
    if (previous.provider === undefined) {
      delete process.env.MAKO_ACP_PROVIDER;
    } else {
      process.env.MAKO_ACP_PROVIDER = previous.provider;
    }
  });

  it("reports adapter found via env override", () => {
    const status = manager.getStatus();
    const claude = status.providers.find(p => p.id === "claude");
    assert.ok(claude);
    assert.equal(claude.adapterFound, true);
    assert.match(claude.adapterCommand || "", /tsx/);
  });

  it("creates a session, prompts, and streams text", async () => {
    const events: AcpBridgeEvent[] = [];
    const unsub = manager.subscribeAll(event => {
      events.push(event);
    });

    const session = await manager.createSession({
      providerId: "claude",
      cwd: process.cwd(),
      title: "test",
    });
    assert.ok(session.id);

    const result = await manager.prompt(session.id, "hello from test");
    assert.equal(result.stopReason, "end_turn");

    const texts = events
      .filter(e => e.type === "session_update")
      .map(e => {
        const update = e.update as {
          sessionUpdate?: string;
          content?: { type?: string; text?: string };
        };
        if (
          update.sessionUpdate === "agent_message_chunk" &&
          update.content?.type === "text"
        ) {
          return update.content.text || "";
        }
        return "";
      })
      .join("");

    assert.match(texts, /Mock agent received: hello from test/);
    assert.ok(events.some(e => e.type === "turn_done"));

    unsub();
    await manager.closeSession(session.id);
  });

  it("attaches Mako MCP on session/new when requested", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response("{}", { status: 200 })) as typeof fetch;
    try {
      const session = await manager.createSession({
        providerId: "claude",
        cwd: process.cwd(),
        title: "mcp-attach",
        attachMakoMcp: true,
        mcpUrl: "https://example.com/api/mcp",
        mcpAuthorization: "Bearer mcpat_test",
        mcpServerName: "mako-workspace",
      });
      assert.equal(session.makoMcpAttached, true);
      await manager.closeSession(session.id);
    } finally {
      globalThis.fetch = originalFetch;
    }

    const without = await manager.createSession({
      providerId: "claude",
      cwd: process.cwd(),
    });
    assert.equal(without.makoMcpAttached, false);
    await manager.closeSession(without.id);
  });

  it("fails session/new when Mako MCP probe returns 401", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response("unauthorized", { status: 401 })) as typeof fetch;
    try {
      await assert.rejects(
        () =>
          manager.createSession({
            providerId: "claude",
            cwd: process.cwd(),
            attachMakoMcp: true,
            mcpUrl: "https://example.com/api/mcp",
            mcpAuthorization: "Bearer bad",
            mcpServerName: "mako-workspace",
          }),
        /auth failed/i,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("records an event log that can be replayed after subscribe", async () => {
    const session = await manager.createSession({
      providerId: "claude",
      cwd: process.cwd(),
      title: "replay-test",
    });

    await manager.prompt(session.id, "first turn");
    await manager.prompt(session.id, "second turn");

    const log = manager.getEventLog(session.id);
    const userTexts = log
      .filter(e => e.type === "session_update")
      .map(e => {
        const update = e.update as {
          sessionUpdate?: string;
          content?: { type?: string; text?: string };
        };
        if (
          update.sessionUpdate === "user_message_chunk" &&
          update.content?.type === "text"
        ) {
          return update.content.text || "";
        }
        return "";
      })
      .filter(Boolean);

    assert.deepEqual(userTexts, ["first turn", "second turn"]);
    assert.ok(
      log.some(
        e =>
          e.type === "session_update" &&
          (e.update as { sessionUpdate?: string }).sessionUpdate ===
            "agent_message_chunk",
      ),
      "expected agent message chunks in the event log",
    );

    // A late subscriber should still receive live events; backlog is served
    // by getEventLog / the HTTP SSE route.
    const live: AcpBridgeEvent[] = [];
    const unsub = manager.subscribe(session.id, event => {
      live.push(event);
    });
    await manager.prompt(session.id, "third turn");
    assert.ok(live.some(e => e.type === "turn_done"));
    assert.equal(
      manager
        .getEventLog(session.id)
        .filter(
          e =>
            e.type === "session_update" &&
            (e.update as { sessionUpdate?: string }).sessionUpdate ===
              "user_message_chunk",
        ).length,
      3,
    );

    unsub();
    await manager.closeSession(session.id);
  });

  it("handles permission requests", async () => {
    const session = await manager.createSession({
      providerId: "claude",
      cwd: process.cwd(),
    });

    const permissionWait = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("timed out waiting for permission")),
        10000,
      );
      const unsub = manager.subscribe(session.id, event => {
        if (event.type === "permission_request") {
          clearTimeout(timer);
          unsub();
          resolve(event.requestId);
        }
      });
    });

    const promptPromise = manager.prompt(session.id, "please ask permission");
    const requestId = await permissionWait;
    manager.respondPermission(session.id, requestId, {
      outcome: "selected",
      optionId: "allow-once",
    });

    const result = await promptPromise;
    assert.equal(result.stopReason, "end_turn");
    await manager.closeSession(session.id);
  });
});
