/**
 * Minimal ACP agent for local-agent tests (stdio JSON-RPC).
 *
 * Run: tsx src/acp/mock-agent.ts
 */
import * as acp from "@agentclientprotocol/sdk";
import { Readable, Writable } from "node:stream";

async function main(): Promise<void> {
  const input = Writable.toWeb(process.stdout);
  const output = Readable.toWeb(process.stdin);

  // Agent reads client→agent on stdin (output stream above) and writes on stdout.
  const stream = acp.ndJsonStream(input, output);

  const sessions = new Map<
    string,
    { pending?: AbortController; mcpServers?: unknown[] }
  >();

  await acp
    .agent({ name: "mako-mock-acp-agent" })
    .onRequest(acp.methods.agent.initialize, async () => ({
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: false,
        mcpCapabilities: { http: true, sse: false },
      },
      authMethods: [],
    }))
    .onRequest(acp.methods.agent.authenticate, async () => ({}))
    .onRequest(acp.methods.agent.session.new, async ctx => {
      const sessionId = `mock_${crypto.randomUUID()}`;
      const mcpServers = Array.isArray(
        (ctx.params as { mcpServers?: unknown[] }).mcpServers,
      )
        ? (ctx.params as { mcpServers: unknown[] }).mcpServers
        : [];
      sessions.set(sessionId, { mcpServers });
      // Echo attached MCP names in a well-known place for tests.
      return {
        sessionId,
        _meta: {
          makoMockMcpServerCount: mcpServers.length,
          makoMockMcpServerNames: mcpServers.map(server =>
            server &&
            typeof server === "object" &&
            "name" in server &&
            typeof (server as { name: unknown }).name === "string"
              ? (server as { name: string }).name
              : "unknown",
          ),
        },
      };
    })
    .onRequest(acp.methods.agent.session.close, async ctx => {
      sessions.delete(String(ctx.params.sessionId));
      return {};
    })
    .onNotification(acp.methods.agent.session.cancel, ctx => {
      const session = sessions.get(String(ctx.params.sessionId));
      session?.pending?.abort();
    })
    .onRequest(acp.methods.agent.session.prompt, async ctx => {
      const sessionId = String(ctx.params.sessionId);
      const session = sessions.get(sessionId);
      if (!session) {
        throw new Error(`Unknown session ${sessionId}`);
      }
      session.pending?.abort();
      session.pending = new AbortController();
      const signal = session.pending.signal;

      const userText = (ctx.params.prompt || [])
        .map((block: { type?: string; text?: string }) =>
          block?.type === "text" ? String(block.text || "") : "",
        )
        .join("");

      await ctx.client.notify(acp.methods.client.session.update, {
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: `Mock agent received: ${userText || "(empty)"}`,
          },
        },
      });

      // "sleep N" keeps the turn busy so overlapping prompt/cancel can be tested.
      const sleepMatch = /sleep\s+(\d+)/i.exec(userText);
      if (sleepMatch) {
        const ms = Math.min(Number(sleepMatch[1]) || 0, 30_000);
        await new Promise<void>(resolve => {
          const timer = setTimeout(resolve, ms);
          signal.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              resolve();
            },
            { once: true },
          );
        });
      }

      if (signal.aborted) {
        return { stopReason: "cancelled" };
      }

      // Optional permission round-trip when prompt contains "permission".
      if (/permission/i.test(userText)) {
        const permission = await ctx.client.request(
          acp.methods.client.session.requestPermission,
          {
            sessionId,
            toolCall: {
              toolCallId: "mock_tool_1",
              title: "Mock write",
              kind: "edit",
              status: "pending",
            },
            options: [
              {
                optionId: "allow-once",
                name: "Allow once",
                kind: "allow_once",
              },
              {
                optionId: "reject-once",
                name: "Deny",
                kind: "reject_once",
              },
            ],
          },
        );

        const selected =
          permission &&
          typeof permission === "object" &&
          "outcome" in permission
            ? (permission as { outcome: { outcome: string; optionId?: string } })
                .outcome
            : { outcome: "cancelled" };

        await ctx.client.notify(acp.methods.client.session.update, {
          sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: {
              type: "text",
              text: ` Permission outcome: ${selected.outcome}${
                selected.optionId ? ` (${selected.optionId})` : ""
              }`,
            },
          },
        });
      }

      session.pending = undefined;
      return { stopReason: signal.aborted ? "cancelled" : "end_turn" };
    })
    .connect(stream).closed;
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
