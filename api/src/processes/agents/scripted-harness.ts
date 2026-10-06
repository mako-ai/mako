/**
 * A deterministic harness for tests and demos: a script decides which tools
 * to call and what to submit — no model involved. It still goes through the
 * runtime (tool provisioning, ledger, trace), so process tests exercise the
 * real plumbing.
 *
 *   ctx.agent("Investigate", { ..., harness: scriptedHarness(async (a) => {
 *     const hits = await a.call("crm__contact__search", { email });
 *     return { found: hits.length > 0 };
 *   }) })
 *
 * Or set it as the default harness in tests (setRuntimeDeps).
 */
import type {
  AgentHarness,
  AgentRequest,
  AgentRuntime,
  AgentToolCallRecord,
} from "./harness";

export interface ScriptApi {
  request: AgentRequest;
  /** Call a provisioned tool by its model-facing name. Throws on error. */
  call(toolName: string, input: unknown): Promise<unknown>;
  /** Emit a free-text message into the trace (one turn). */
  say(text: string): Promise<void>;
}

export type AgentScript = (api: ScriptApi) => Promise<unknown>;

export function scriptedHarness(script: AgentScript): AgentHarness {
  return {
    id: "scripted",
    async run(request: AgentRequest, rt: AgentRuntime) {
      let iteration = (await rt.previousTurns()).length;
      let toolCalls = 0;
      const api: ScriptApi = {
        request,
        async call(toolName, input) {
          const runtimeTool = request.tools.find(t => t.name === toolName);
          if (!runtimeTool) {
            throw new Error(
              `Tool "${toolName}" is not provisioned to this agent`,
            );
          }
          const callId = `c${toolCalls++}`;
          const record: AgentToolCallRecord = { callId, tool: toolName, input };
          try {
            record.output = await runtimeTool.invoke(input, {
              iteration,
              callId,
            });
            return record.output;
          } catch (error) {
            record.error =
              error instanceof Error ? error.message : String(error);
            throw error;
          } finally {
            await rt.emitTurn({
              iteration: iteration++,
              model: "scripted",
              toolCalls: [record],
              usage: { inputTokens: 0, outputTokens: 0 },
            });
          }
        },
        async say(text) {
          await rt.emitTurn({
            iteration: iteration++,
            model: "scripted",
            text,
            toolCalls: [],
          });
        },
      };
      const raw = await script(api);
      const output = request.output.parse(raw);
      await rt.emitTurn({
        iteration: iteration++,
        model: "scripted",
        toolCalls: [
          {
            callId: "submit",
            tool: "submit_result",
            input: output,
            output: { accepted: true },
          },
        ],
      });
      return {
        output,
        iterations: iteration,
        toolCalls,
        usage: { inputTokens: 0, outputTokens: 0 },
      };
    },
  };
}
