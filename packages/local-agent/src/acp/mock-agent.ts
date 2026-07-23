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

  const sessions = new Map<string, { pending?: AbortController }>();

  await acp
    .agent({ name: "mako-mock-acp-agent" })
    .onRequest(acp.methods.agent.initialize, async () => ({
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: false,
      },
      authMethods: [],
    }))
    .onRequest(acp.methods.agent.authenticate, async () => ({}))
    .onRequest(acp.methods.agent.session.new, async () => {
      const sessionId = `mock_${crypto.randomUUID()}`;
      sessions.set(sessionId, {});
      return { sessionId };
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
