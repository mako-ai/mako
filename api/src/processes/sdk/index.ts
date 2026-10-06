/**
 * The Process SDK — everything a process author imports.
 *
 * A process is `run(ctx, input)` written against five durable primitives:
 *
 *   ctx.step      deterministic code, memoized once it succeeds
 *   ctx.agent     a bounded tool loop with a typed result (one timeline row)
 *   ctx.approval  pause until a person approves/rejects (optionally edits) data
 *   ctx.task      pause until a person fills in a form
 *   ctx.wait      durable sleep, or wait for a business event
 *
 * Read `api/src/processes/README.md` before writing one. The rules that matter:
 * side effects only inside primitives; step names identify steps; return JSON.
 */
import { z } from "zod";
import type { AgentHarness } from "../agents/harness";

export { z };

// ── Durations ──────────────────────────────────────────────────────────────

/** Milliseconds, or a string like "30s", "15m", "24h", "7d". */
export type Duration = number | `${number}${"ms" | "s" | "m" | "h" | "d"}`;

const UNIT_MS = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };

export function toMs(duration: Duration): number {
  if (typeof duration === "number") return duration;
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/.exec(duration);
  if (!match) throw new Error(`Invalid duration "${duration}"`);
  return Math.round(
    Number(match[1]) * UNIT_MS[match[2] as keyof typeof UNIT_MS],
  );
}

// ── Tools ──────────────────────────────────────────────────────────────────

/**
 * What a tool does to the world. Drives retry and provisioning policy:
 * - read:        retried freely; the only effect agents get by default
 * - write:       must be idempotent (forward `idempotencyKey` to the vendor)
 * - destructive: never retried blindly (ledger + reconcile); refused in agents
 */
export type ToolEffect = "read" | "write" | "destructive";

export interface ResolvedConnection {
  id: string;
  kind: "database" | "source";
  type: string;
  name: string;
}

export interface ToolContext {
  workspaceId: string;
  runId: string;
  /** Stable across retries of this exact call. Forward it to vendor APIs. */
  idempotencyKey: string;
  signal: AbortSignal;
  log(message: string, data?: Record<string, unknown>): void;
  /**
   * The connection the workspace bound to one of this tool's declared slots.
   * Throws for undeclared or unbound slots — tools never see anything else.
   */
  connection(slot: string): Promise<ResolvedConnection>;
}

export interface ToolDefinition<I = any, O = any> {
  /** Dotted, stable, e.g. "crm.contact.delete". Shown in audit logs. */
  name: string;
  /** Written for a model: what it does, when to use it. */
  description: string;
  effect: ToolEffect;
  input: z.ZodType<I>;
  output?: z.ZodType<O>;
  /** Connection binding slots this tool may resolve via `t.connection()`. */
  connections?: readonly string[];
  timeout?: Duration;
  execute(input: I, t: ToolContext): Promise<O>;
  /**
   * Destructive tools only: decide whether a call whose outcome was lost
   * (crash between start and finish) already took effect. Without it, such a
   * call fails the step for manual reconciliation instead of running twice.
   */
  reconcile?(
    input: I,
    t: ToolContext,
  ): Promise<{ done: true; output: O } | { done: false }>;
}

export function defineTool<I, O>(
  tool: ToolDefinition<I, O>,
): ToolDefinition<I, O> {
  if (!/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/.test(tool.name)) {
    throw new Error(
      `Tool name "${tool.name}" must be dotted lower_snake (e.g. "crm.contact.read")`,
    );
  }
  return tool;
}

// ── Triggers ───────────────────────────────────────────────────────────────

export type TriggerSpec =
  | { type: "manual" }
  | { type: "event"; event: string }
  | { type: "schedule"; cron: string; timezone?: string; input?: unknown };

export const trigger = {
  /** Started from the UI or `POST /processes/:id/runs`. */
  manual: (): TriggerSpec => ({ type: "manual" }),
  /** Started by `emitProcessEvent(workspaceId, name, data)`; data = input. */
  event: (event: string): TriggerSpec => ({ type: "event", event }),
  /** Started on a cron schedule (UTC unless `timezone`), with a fixed input. */
  schedule: (
    cron: string,
    options?: { timezone?: string; input?: unknown },
  ): TriggerSpec => ({ type: "schedule", cron, ...options }),
};

// ── Context ────────────────────────────────────────────────────────────────

export interface StepOptions {
  /** Attempts after the first. Default 3. Destructive work: keep low. */
  retries?: number;
  /** Default 5 minutes. */
  timeout?: Duration;
}

export interface StepContext {
  /** 0 on the first attempt. */
  attempt: number;
  /** `${runId}:${stepKey}` — stable across retries of this step. */
  idempotencyKey: string;
  signal: AbortSignal;
  log(message: string, data?: Record<string, unknown>): void;
  /** Store a named artifact (report, CSV, …) on the run. ≤ 1 MB of text. */
  artifact(
    name: string,
    content: string,
    options?: { mimeType?: string },
  ): Promise<void>;
  /** Invoke a tool from the process envelope — audited and ledgered. */
  call<I, O>(tool: ToolDefinition<I, O>, input: I): Promise<O>;
  /**
   * Output of this process's most recent COMPLETED run in this workspace
   * (null if none) — for "what changed since last time" processes.
   */
  previousOutput<T = unknown>(): Promise<T | null>;
}

export interface AgentSpec<T> {
  /** System prompt: the job, the constraints, what "done" means. */
  instructions: string;
  /** The task input. Objects are passed as JSON. */
  prompt: string | object;
  /** Subset of the process envelope. Read tools unless `allowEffects`. */
  tools?: ToolDefinition[];
  /** The typed result the agent must submit. */
  output: z.ZodType<T>;
  /** Gateway model id ("anthropic/claude-sonnet-5-5"); default: workspace default. */
  model?: string;
  /** Opt in to write tools. Destructive tools are never allowed in agents. */
  allowEffects?: Array<"read" | "write">;
  maxIterations?: number; // default 20
  maxToolCalls?: number; // default 50
  timeout?: Duration; // default 15m
  retries?: number; // default 2 (the agent resumes from its trace)
  harness?: AgentHarness;
}

export interface Approver {
  id: string;
  name?: string;
  email?: string;
}

export interface ApprovalSpec<T> {
  /** The thing being approved. Frozen at request time for audit. */
  data: T;
  /** If given, the approver may edit `data`; edits are validated. */
  schema?: z.ZodType<T>;
  /** Markdown shown above the data. */
  description?: string;
  /** Emails or user ids allowed to decide. Default: workspace admins. */
  assignees?: string[];
  /** Default 14 days. On expiry: `{ approved: false, outcome: "expired" }`. */
  timeout?: Duration;
}

export interface ApprovalResult<T> {
  approved: boolean;
  outcome: "approved" | "rejected" | "expired";
  /** The approved data — the approver's edit if they made one. */
  data: T;
  comment?: string;
  by?: Approver;
  at: string;
}

export interface TaskSpec<T extends Record<string, unknown>> {
  form: z.ZodType<T>;
  description?: string;
  prefill?: Partial<T>;
  assignees?: string[];
  /** Default 14 days. On expiry `ctx.task` throws HumanRequestExpiredError. */
  timeout?: Duration;
}

export interface TaskResult<T> {
  data: T;
  by?: Approver;
  at: string;
}

export type WaitSpec =
  | { for: Duration }
  | { until: Date | string }
  | {
      /** Business event name, emitted with `emitProcessEvent`. */
      event: string;
      /** Every key must equal the event's data at that key. */
      match?: Record<string, string | number | boolean>;
      /** Default 7 days; resolves `null` on timeout. */
      timeout?: Duration;
    };

export interface RunInfo {
  id: string;
  number: number;
  processId: string;
  workspaceId: string;
  trigger: { type: string; by?: string; event?: string };
}

export interface ProcessContext {
  readonly run: RunInfo;
  step<T>(
    name: string,
    fn: (s: StepContext) => Promise<T>,
    options?: StepOptions,
  ): Promise<T>;
  agent<T>(name: string, spec: AgentSpec<T>): Promise<T>;
  approval<T>(title: string, spec: ApprovalSpec<T>): Promise<ApprovalResult<T>>;
  task<T extends Record<string, unknown>>(
    title: string,
    spec: TaskSpec<T>,
  ): Promise<TaskResult<T>>;
  wait(
    name: string,
    spec: { for: Duration } | { until: Date | string },
  ): Promise<void>;
  wait<E = Record<string, unknown>>(
    name: string,
    spec: {
      event: string;
      match?: Record<string, string | number | boolean>;
      timeout?: Duration;
    },
  ): Promise<E | null>;
}

// ── Process ────────────────────────────────────────────────────────────────

export interface ProcessDefinition<I = any, O = any> {
  /** Stable kebab-case id. Renaming it creates a new process. */
  id: string;
  name: string;
  description?: string;
  /** Free-form grouping for the list ("compliance", "sales", …). */
  category?: string;
  triggers: TriggerSpec[];
  input: z.ZodType<I>;
  /** The tool envelope: everything this process may ever call. */
  tools?: ToolDefinition[];
  run(ctx: ProcessContext, input: I): Promise<O>;
}

export function defineProcess<I, O>(
  definition: ProcessDefinition<I, O>,
): ProcessDefinition<I, O> {
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(definition.id)) {
    throw new Error(`Process id "${definition.id}" must be kebab-case`);
  }
  if (definition.triggers.length === 0) {
    throw new Error(`Process "${definition.id}" needs at least one trigger`);
  }
  const names = new Set<string>();
  for (const tool of definition.tools ?? []) {
    if (names.has(tool.name)) {
      throw new Error(
        `Process "${definition.id}" declares tool "${tool.name}" twice`,
      );
    }
    names.add(tool.name);
  }
  return definition;
}

// ── Errors authors may catch or throw ──────────────────────────────────────

/** Thrown by `ctx.task` when nobody responded before the timeout. */
export class HumanRequestExpiredError extends Error {
  constructor(title: string) {
    super(`Human request "${title}" expired without a response`);
    this.name = "HumanRequestExpiredError";
  }
}

/** Throw from a step to fail it immediately, without retries. */
export class PermanentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermanentError";
  }
}
