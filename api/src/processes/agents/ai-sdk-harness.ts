/**
 * The default agent harness: a bounded tool loop on the Vercel AI SDK, routed
 * through Mako's AI Gateway (`getModel`).
 *
 * - One model call per iteration (`stopWhen: stepCountIs(1)`); each iteration
 *   is persisted via `rt.emitTurn` and is the resume point after a crash.
 * - Tool execution is delegated to `RuntimeTool.invoke` (runtime-owned
 *   provisioning, ledger, audit). Tool errors go back to the model as data.
 * - The result is a forced `submit_result` tool call validated against the
 *   output schema — provider-agnostic structured output.
 */
import {
  generateText,
  stepCountIs,
  tool,
  type LanguageModel,
  type ModelMessage,
  type ToolSet,
} from "ai";
import { z } from "zod";
import { buildProviderOptions, getModel } from "../../agent-lib/ai-gateway";
import {
  AgentLimitError,
  addUsage,
  type AgentHarness,
  type AgentRequest,
  type AgentRuntime,
  type AgentToolCallRecord,
  type AgentUsage,
} from "./harness";

export const SUBMIT_TOOL = "submit_result";

const SUBMIT_GUIDANCE = `

When you have everything you need, call \`${SUBMIT_TOOL}\` exactly once with the final result. Do not answer in plain text: only \`${SUBMIT_TOOL}\` ends the task. If a tool fails, decide whether to retry, try another approach, or report the gap in your result.`;

function gatewayCost(providerMetadata: unknown): number | undefined {
  const cost = (
    providerMetadata as { gateway?: { cost?: unknown } } | undefined
  )?.gateway?.cost;
  const n = typeof cost === "string" ? Number(cost) : cost;
  return typeof n === "number" && Number.isFinite(n) ? n : undefined;
}

export function aiSdkHarness(
  options: { resolveModel?: (id: string) => LanguageModel } = {},
): AgentHarness {
  const resolveModel = options.resolveModel ?? getModel;
  return {
    id: "ai-sdk",
    async run(req: AgentRequest, rt: AgentRuntime) {
      const wrapsOutput = req.outputJsonSchema.type !== "object";
      const submitSchema: z.ZodType = wrapsOutput
        ? z.object({ result: req.output })
        : req.output;

      let submitted: { value: unknown } | null = null;
      let iteration = 0;
      let toolCallCount = 0;
      let usage: AgentUsage = { inputTokens: 0, outputTokens: 0 };
      const messages: ModelMessage[] = [{ role: "user", content: req.prompt }];

      // Resume: replay the transcript of earlier attempts.
      const previous = await rt.previousTurns();
      const resumable = previous.every(t => Array.isArray(t.messages));
      for (const turn of previous) {
        if (resumable) messages.push(...(turn.messages as ModelMessage[]));
        iteration = Math.max(iteration, turn.iteration + 1);
        toolCallCount += turn.toolCalls.length;
        usage = addUsage(usage, turn.usage);
        const submit = turn.toolCalls.find(
          c => c.tool === SUBMIT_TOOL && !c.error,
        );
        if (submit) {
          const parsed = submitSchema.safeParse(submit.input);
          if (parsed.success) submitted = { value: parsed.data };
        }
      }
      const unwrap = (value: unknown) =>
        wrapsOutput ? (value as { result: unknown }).result : value;
      if (submitted) {
        return {
          output: unwrap(submitted.value),
          iterations: iteration,
          toolCalls: toolCallCount,
          usage,
        };
      }

      let currentIteration = iteration;
      const tools: ToolSet = {};
      for (const runtimeTool of req.tools) {
        tools[runtimeTool.name] = tool({
          description: runtimeTool.description,
          inputSchema: runtimeTool.inputSchema,
          execute: async (input: unknown, { toolCallId }) => {
            if (toolCallCount >= req.limits.maxToolCalls) {
              return {
                error: `Tool-call budget (${req.limits.maxToolCalls}) exhausted. Call ${SUBMIT_TOOL} now.`,
              };
            }
            toolCallCount++;
            try {
              return await runtimeTool.invoke(input, {
                iteration: currentIteration,
                callId: toolCallId,
              });
            } catch (error) {
              return {
                error: error instanceof Error ? error.message : String(error),
              };
            }
          },
        });
      }
      tools[SUBMIT_TOOL] = tool({
        description:
          "Submit the final structured result of this task. Call exactly once, when done.",
        inputSchema: submitSchema,
        execute: async (value: unknown) => {
          submitted = { value };
          return { accepted: true };
        },
      });

      while (iteration < req.limits.maxIterations) {
        currentIteration = iteration;
        const mustSubmit =
          iteration === req.limits.maxIterations - 1 ||
          toolCallCount >= req.limits.maxToolCalls;
        const result = await generateText({
          model: resolveModel(req.model),
          system: req.instructions + SUBMIT_GUIDANCE,
          messages,
          tools,
          toolChoice: mustSubmit
            ? { type: "tool", toolName: SUBMIT_TOOL }
            : "required",
          stopWhen: stepCountIs(1),
          abortSignal: req.signal,
          providerOptions: buildProviderOptions({
            userId: `process-run:${req.runId}`,
            workspaceId: req.workspaceId,
            invocationType: "process_agent",
            promptCacheSessionId: `${req.runId}:${req.stepKey}`,
          }),
        });
        messages.push(...result.response.messages);

        const outcomes = new Map<
          string,
          { output?: unknown; error?: string }
        >();
        for (const part of result.content) {
          if (part.type === "tool-result") {
            outcomes.set(part.toolCallId, { output: part.output });
          } else if (part.type === "tool-error") {
            outcomes.set(part.toolCallId, { error: String(part.error) });
          }
        }
        const toolCalls: AgentToolCallRecord[] = result.toolCalls.map(call => ({
          callId: call.toolCallId,
          tool: call.toolName,
          input: call.input,
          ...outcomes.get(call.toolCallId),
        }));
        const turnUsage: AgentUsage = {
          inputTokens: result.usage.inputTokens ?? 0,
          outputTokens: result.usage.outputTokens ?? 0,
          ...(gatewayCost(result.providerMetadata) !== undefined
            ? { costUsd: gatewayCost(result.providerMetadata) }
            : {}),
        };
        usage = addUsage(usage, turnUsage);
        await rt.emitTurn({
          iteration,
          model: result.response.modelId ?? req.model,
          text: result.text || undefined,
          reasoning: result.reasoningText || undefined,
          toolCalls,
          usage: turnUsage,
          finishReason: result.finishReason,
          messages: result.response.messages,
        });
        iteration++;
        if (submitted) {
          return {
            output: unwrap((submitted as { value: unknown }).value),
            iterations: iteration,
            toolCalls: toolCallCount,
            usage,
          };
        }
      }
      throw new AgentLimitError(
        `Agent did not submit a result within ${req.limits.maxIterations} iterations`,
      );
    },
  };
}
