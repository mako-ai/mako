/**
 * The agent harness seam.
 *
 * The process runtime does not care which agent loop runs an `ctx.agent()`
 * call. It hands the harness a request (instructions, prompt, tools, output
 * schema, limits) and a runtime (trace sink + previous turns for resume), and
 * expects a validated output back.
 *
 * The RUNTIME owns: which tools exist (`RuntimeTool.invoke` is provisioned,
 * validated, ledgered and audited), limits, timeouts, trace storage, usage
 * rollup. The HARNESS owns: the loop.
 *
 * Implementations: `aiSdkHarness` (Vercel AI SDK via Mako's gateway — the
 * default) and `scriptedHarness` (deterministic, for tests). A Claude Agent
 * SDK / OpenAI Agents SDK harness would expose `RuntimeTool`s as in-process
 * MCP/function tools and use `previousTurns()` (or its own session resume) to
 * continue after a crash.
 */
import type { z } from "zod";

export interface RuntimeTool {
  name: string;
  description: string;
  /** JSON Schema of the tool input (for harnesses that need it). */
  inputJsonSchema: Record<string, unknown>;
  /** The zod schema (for harnesses built on zod, e.g. the AI SDK). */
  inputSchema: z.ZodType;
  /** Execute through the runtime: validation, ledger, audit, timeout. */
  invoke(
    input: unknown,
    meta: { iteration: number; callId: string },
  ): Promise<unknown>;
}

export interface AgentUsage {
  inputTokens: number;
  outputTokens: number;
  costUsd?: number;
}

export interface AgentToolCallRecord {
  callId: string;
  tool: string;
  input: unknown;
  output?: unknown;
  error?: string;
}

/**
 * One model call and the tool calls it made. Persisted as an `agent.turn`
 * event: it is simultaneously the visible trace AND the checkpoint a harness
 * resumes from. `messages` is harness-private replay state.
 */
export interface AgentTurn {
  iteration: number;
  model: string;
  text?: string;
  reasoning?: string;
  toolCalls: AgentToolCallRecord[];
  usage?: AgentUsage;
  finishReason?: string;
  messages?: unknown[];
}

export interface AgentRequest {
  workspaceId: string;
  runId: string;
  stepKey: string;
  model: string;
  instructions: string;
  prompt: string;
  tools: RuntimeTool[];
  output: z.ZodType;
  outputJsonSchema: Record<string, unknown>;
  limits: { maxIterations: number; maxToolCalls: number; timeoutMs: number };
  signal: AbortSignal;
}

export interface AgentRuntime {
  emitTurn(turn: AgentTurn): Promise<void>;
  /** Turns already persisted by earlier attempts of this same agent step. */
  previousTurns(): Promise<AgentTurn[]>;
}

export interface AgentResult {
  output: unknown;
  iterations: number;
  toolCalls: number;
  usage: AgentUsage;
}

export interface AgentHarness {
  readonly id: string;
  run(request: AgentRequest, runtime: AgentRuntime): Promise<AgentResult>;
}

export class AgentLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentLimitError";
  }
}

export function addUsage(a: AgentUsage, b?: AgentUsage): AgentUsage {
  if (!b) return a;
  const cost =
    a.costUsd === undefined && b.costUsd === undefined
      ? undefined
      : (a.costUsd ?? 0) + (b.costUsd ?? 0);
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    ...(cost === undefined ? {} : { costUsd: cost }),
  };
}
