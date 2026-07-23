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
