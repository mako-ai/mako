/**
 * ProcessContext — the five primitives, implemented over a Driver + journal.
 *
 * Invariants (each one is load-bearing):
 *
 * 1. Every journal/DB WRITE happens inside a `driver.run()` callback. Code
 *    outside driver steps re-executes on every replay, so a write there would
 *    duplicate.
 * 2. Every primitive first checks the journal memo (`step:<key>`), so a step
 *    that completed is never re-executed — even in a new engine execution
 *    ("retry run") where the engine's own memo is empty.
 * 3. Step keys derive from names + call order, so they are deterministic
 *    across replays.
 * 4. Non-read tool calls go through the effect ledger (see `invokeTool`).
 */
import { Types } from "mongoose";
import { z } from "zod";
import {
  type AgentSpec,
  type ApprovalResult,
  type ApprovalSpec,
  type Duration,
  type ProcessContext,
  type ProcessDefinition,
  type ResolvedConnection,
  type RunInfo,
  type StepContext,
  type StepOptions,
  type TaskResult,
  type TaskSpec,
  type ToolContext,
  type ToolDefinition,
  type WaitSpec,
  HumanRequestExpiredError,
  toMs,
} from "../sdk";
import type { AgentTurn, RuntimeTool } from "../agents/harness";
import {
  append,
  capForDisplay,
  errorMessage,
  findByDedupeKey,
  listEvents,
  toJson,
  type JournalScope,
} from "./journal";
import {
  HumanRequest,
  ProcessInstallation,
  ProcessRun,
  type IHumanRequest,
  type IProcessRun,
  type WaitingOn,
} from "./models";
import {
  NonRetryableStepError,
  RunCancelledError,
  isNonRetryable,
  type Driver,
} from "./driver";
import { getRuntimeDeps } from "./deps";

const DEFAULT_STEP_RETRIES = 3;
const DEFAULT_STEP_TIMEOUT: Duration = "5m";
const DEFAULT_AGENT_RETRIES = 2;
const DEFAULT_AGENT_TIMEOUT: Duration = "15m";
const DEFAULT_HUMAN_TIMEOUT: Duration = "14d";
const DEFAULT_EVENT_TIMEOUT: Duration = "7d";
const DEFAULT_TOOL_TIMEOUT: Duration = "2m";
const HOUSEKEEPING = { retries: 3 };

/** Thrown out of `ctx.*` when a step failed permanently. Catchable. */
export class ProcessStepError extends Error {
  constructor(
    readonly stepKey: string,
    readonly stepName: string,
    message: string,
  ) {
    super(`Step "${stepName}" failed: ${message}`);
    this.name = "ProcessStepError";
  }
}

export function stepSlug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "step"
  );
}

/** Model-facing tool names: providers accept [a-zA-Z0-9_-]. */
export function modelToolName(name: string): string {
  return name.replace(/\./g, "__");
}

export interface ExecutionScope {
  run: Pick<
    IProcessRun,
    "_id" | "workspaceId" | "processId" | "number" | "trigger"
  >;
  definition: ProcessDefinition;
  /** The version of the code executing NOW (may differ from run.versionId). */
  versionId: string;
  driver: Driver;
}

async function withTimeout<T>(
  work: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  what: string,
): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new TimeoutError(`${what} timed out after ${timeoutMs} ms`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([work(controller.signal), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimeoutError";
  }
}

export function createProcessContext(scope: ExecutionScope): ProcessContext {
  const runId = scope.run._id.toString();
  const workspaceId = scope.run.workspaceId.toString();
  const journal: JournalScope = {
    runId,
    workspaceId,
    versionId: scope.versionId,
  };
  const { driver, definition } = scope;
  const deps = getRuntimeDeps();

  const envelope = new Map<string, ToolDefinition>();
  for (const tool of definition.tools ?? []) envelope.set(tool.name, tool);

  // ── step keys ────────────────────────────────────────────────────────────
  const seen = new Map<string, number>();
  function nextKey(name: string): string {
    const slug = stepSlug(name);
    const count = (seen.get(slug) ?? 0) + 1;
    seen.set(slug, count);
    return count === 1 ? slug : `${slug}#${count}`;
  }

  // ── shared helpers (call only inside driver.run) ─────────────────────────
  async function memo<T>(key: string): Promise<{ output: T } | null> {
    const done = await findByDedupeKey(runId, `step:${key}`);
    return done ? { output: done.data.output as T } : null;
  }

  async function assertActive(): Promise<void> {
    const current = await ProcessRun.findById(scope.run._id)
      .select("status")
      .lean();
    if (!current || current.status === "cancelled") {
      throw new RunCancelledError();
    }
  }

  async function setWaiting(waitingOn: WaitingOn): Promise<void> {
    await ProcessRun.updateOne(
      { _id: scope.run._id, status: { $in: ["queued", "running", "waiting"] } },
      { $set: { status: "waiting", waitingOn } },
    );
  }

  async function setRunning(stepKey: string): Promise<void> {
    await ProcessRun.updateOne(
      {
        _id: scope.run._id,
        status: "waiting",
        "waitingOn.stepKey": stepKey,
      },
      { $set: { status: "running", waitingOn: null } },
    );
  }

  async function complete<T>(
    key: string,
    name: string,
    kind: string,
    output: T,
    startedAtMs?: number,
  ): Promise<T> {
    const json = toJson(output, `Result of "${name}"`);
    const { inserted } = await append(journal, {
      type: "step.completed",
      stepKey: key,
      dedupeKey: `step:${key}`,
      data: {
        name,
        kind,
        output: json,
        ...(startedAtMs ? { durationMs: Date.now() - startedAtMs } : {}),
      },
    });
    if (!inserted) {
      // A concurrent duplicate finished first: its result is the result.
      const existing = await memo<T>(key);
      if (existing) return existing.output;
    }
    return json;
  }

  // ── tools: provisioning, ledger, audit ───────────────────────────────────
  async function resolveSlot(
    tool: ToolDefinition,
    slot: string,
  ): Promise<ResolvedConnection> {
    if (!tool.connections?.includes(slot)) {
      throw new NonRetryableStepError(
        `Tool "${tool.name}" did not declare connection slot "${slot}"`,
      );
    }
    const installation = await ProcessInstallation.findOne({
      workspaceId: scope.run.workspaceId,
      processId: definition.id,
    })
      .select("bindings")
      .lean();
    const connectionId = installation?.bindings?.[slot];
    if (!connectionId) {
      throw new NonRetryableStepError(
        `Connection slot "${slot}" is not bound for process "${definition.id}". ` +
          `Bind it in the process settings.`,
      );
    }
    return deps.resolveConnection(workspaceId, connectionId);
  }

  async function invokeTool(
    tool: ToolDefinition,
    rawInput: unknown,
    call: {
      callKey: string;
      stepKey: string;
      caller: "step" | "agent";
      iteration?: number;
    },
  ): Promise<unknown> {
    const declared = envelope.get(tool.name);
    if (!declared || declared !== tool) {
      throw new NonRetryableStepError(
        `Tool "${tool.name}" is not in the tool envelope of process "${definition.id}"`,
      );
    }
    const parsed = tool.input.safeParse(rawInput);
    if (!parsed.success) {
      throw new NonRetryableStepError(
        `Invalid input for tool "${tool.name}": ${z.prettifyError(parsed.error)}`,
      );
    }
    const input = parsed.data;
    const base = {
      tool: tool.name,
      effect: tool.effect,
      callKey: call.callKey,
      caller: call.caller,
      ...(call.iteration !== undefined ? { iteration: call.iteration } : {}),
    };
    const logs: Promise<unknown>[] = [];
    const makeCtx = (signal: AbortSignal): ToolContext => ({
      workspaceId,
      runId,
      idempotencyKey: `${runId}:${call.callKey}`,
      signal,
      log: (message, data) => {
        logs.push(
          append(journal, {
            type: "log",
            stepKey: call.stepKey,
            data: {
              level: "info",
              message,
              tool: tool.name,
              data: capForDisplay(data),
            },
          }),
        );
      },
      connection: slot => resolveSlot(tool, slot),
    });

    const ledgered = tool.effect !== "read";
    let startKey: string | undefined;
    if (ledgered) {
      const done = await findByDedupeKey(runId, `tool.done:${call.callKey}`);
      if (done) return done.data.output;
      const history = await listEvents(runId, { stepKey: call.stepKey });
      const definitiveFailures = history.filter(
        e =>
          e.type === "tool.failed" &&
          e.data.callKey === call.callKey &&
          e.data.definitive === true,
      ).length;
      startKey =
        definitiveFailures === 0
          ? `tool.start:${call.callKey}`
          : `tool.start:${call.callKey}:r${definitiveFailures}`;
    }

    const started = await append(journal, {
      type: "tool.started",
      stepKey: call.stepKey,
      dedupeKey: startKey,
      data: { ...base, input: capForDisplay(input) },
    });
    await ProcessRun.updateOne(
      { _id: scope.run._id },
      { $inc: { "usage.toolCalls": 1 } },
    );

    if (ledgered && !started.inserted) {
      // An earlier attempt started this exact call and never recorded an
      // outcome: it may or may not have happened.
      if (tool.effect === "destructive") {
        const reconciled = tool.reconcile
          ? await tool.reconcile(input, makeCtx(new AbortController().signal))
          : null;
        if (reconciled?.done) {
          await append(journal, {
            type: "tool.completed",
            stepKey: call.stepKey,
            dedupeKey: `tool.done:${call.callKey}`,
            data: {
              ...base,
              output: toJson(reconciled.output, `Output of ${tool.name}`),
              reconciled: true,
            },
          });
          return reconciled.output;
        }
        if (!reconciled) {
          throw new NonRetryableStepError(
            `Destructive call ${tool.name} (${call.callKey}) was interrupted and its ` +
              `outcome is unknown. It will not be re-run automatically: verify ` +
              `the target system manually (idempotency key ${runId}:${call.callKey}).`,
          );
        }
        // reconcile says it did NOT happen: safe to execute now.
      }
      // write: re-execute under the same idempotency key.
    }

    const startedAt = Date.now();
    try {
      const output = await withTimeout(
        signal => tool.execute(input, makeCtx(signal)),
        toMs(tool.timeout ?? DEFAULT_TOOL_TIMEOUT),
        `Tool ${tool.name}`,
      );
      if (tool.output) {
        const checked = tool.output.safeParse(output);
        if (!checked.success) {
          throw new NonRetryableStepError(
            `Tool "${tool.name}" returned output that does not match its schema: ` +
              z.prettifyError(checked.error),
          );
        }
      }
      await Promise.all(logs);
      await append(journal, {
        type: "tool.completed",
        stepKey: call.stepKey,
        dedupeKey: ledgered ? `tool.done:${call.callKey}` : undefined,
        data: {
          ...base,
          output: ledgered
            ? toJson(output, `Output of ${tool.name}`)
            : capForDisplay(output),
          durationMs: Date.now() - startedAt,
        },
      });
      return output;
    } catch (error) {
      await Promise.all(logs).catch(() => undefined);
      // A tool that throws reports a definitive failure (the effect did not
      // happen). A timeout does not: the outcome is unknown.
      await append(journal, {
        type: "tool.failed",
        stepKey: call.stepKey,
        data: {
          ...base,
          error: errorMessage(error),
          definitive: !(error instanceof TimeoutError),
          durationMs: Date.now() - startedAt,
        },
      });
      throw error;
    }
  }

  // ── the step skeleton shared by step + agent ─────────────────────────────
  async function runStep<T>(
    key: string,
    name: string,
    kind: "step" | "agent",
    options: { retries: number; timeout: Duration },
    body: (s: StepContext, signal: AbortSignal, attempt: number) => Promise<T>,
  ): Promise<T> {
    try {
      return await driver.run(
        key,
        async attempt => {
          const cached = await memo<T>(key);
          if (cached) return cached.output;
          await assertActive();
          await append(journal, {
            type: "step.started",
            stepKey: key,
            data: { name, kind, attempt },
          });
          const startedAt = Date.now();
          const pending: Promise<unknown>[] = [];
          let callIndex = 0;
          try {
            const output = await withTimeout(
              signal => {
                const s: StepContext = {
                  attempt,
                  idempotencyKey: `${runId}:${key}`,
                  signal,
                  log: (message, data) => {
                    pending.push(
                      append(journal, {
                        type: "log",
                        stepKey: key,
                        data: {
                          level: "info",
                          message,
                          data: capForDisplay(data),
                        },
                      }),
                    );
                  },
                  artifact: async (artifactName, content, opts) => {
                    if (content.length > 1_000_000) {
                      throw new Error(
                        `Artifact "${artifactName}" exceeds 1 MB`,
                      );
                    }
                    await append(journal, {
                      type: "artifact.created",
                      stepKey: key,
                      data: {
                        name: artifactName,
                        mimeType: opts?.mimeType ?? "text/plain",
                        content,
                        attempt,
                      },
                    });
                  },
                  previousOutput: async <P>() => {
                    const previous = await ProcessRun.findOne({
                      workspaceId: scope.run.workspaceId,
                      processId: definition.id,
                      status: "completed",
                      _id: { $ne: scope.run._id },
                    })
                      .sort({ endedAt: -1 })
                      .select("output")
                      .lean();
                    return (previous?.output ?? null) as P | null;
                  },
                  call: async <I, O>(tool: ToolDefinition<I, O>, input: I) =>
                    (await invokeTool(tool, input, {
                      callKey: `${key}:${callIndex++}`,
                      stepKey: key,
                      caller: "step",
                    })) as O,
                };
                return body(s, signal, attempt);
              },
              toMs(options.timeout),
              `Step "${name}"`,
            );
            await Promise.all(pending);
            return await complete(key, name, kind, output, startedAt);
          } catch (error) {
            await Promise.all(pending).catch(() => undefined);
            await append(journal, {
              type: "step.failed",
              stepKey: key,
              data: {
                name,
                kind,
                attempt,
                error: errorMessage(error),
                willRetry: !isNonRetryable(error) && attempt < options.retries,
                durationMs: Date.now() - startedAt,
              },
            });
            throw error;
          }
        },
        { retries: options.retries },
      );
    } catch (error) {
      throw asStepError(key, name, error);
    }
  }

  function asStepError(key: string, name: string, error: unknown): Error {
    if (error instanceof ProcessStepError) return error;
    if (error instanceof Error && error.name === "Suspend") return error;
    if (error instanceof RunCancelledError) return error;
    const failure = new ProcessStepError(key, name, errorMessage(error));
    return failure;
  }

  // ── human requests (approval + task) ─────────────────────────────────────
  interface HumanDecision {
    status: IHumanRequest["status"];
    response?: IHumanRequest["response"];
    respondedBy?: IHumanRequest["respondedBy"];
    respondedAt?: string;
  }

  async function readDecision(
    requestId: string,
  ): Promise<HumanDecision | null> {
    const request = await HumanRequest.findById(requestId).lean();
    if (!request) throw new NonRetryableStepError("Human request disappeared");
    if (request.status === "pending") return null;
    return {
      status: request.status,
      response: request.response,
      respondedBy: request.respondedBy,
      respondedAt: request.respondedAt?.toISOString(),
    };
  }

  async function human<R>(
    kind: "approval" | "task",
    title: string,
    request: {
      payload: unknown;
      schema?: z.ZodType;
      description?: string;
      assignees?: string[];
      timeout?: Duration;
    },
    finish: (decision: HumanDecision | null) => R,
  ): Promise<R> {
    const key = nextKey(title);
    const opened = await driver.run(
      `${key}:request`,
      async () => {
        const cached = await memo<R>(key);
        if (cached) return { memo: cached.output };
        await assertActive();
        const expiresAt = new Date(
          deps.now().getTime() + toMs(request.timeout ?? DEFAULT_HUMAN_TIMEOUT),
        );
        const payload = toJson(request.payload, `Data for "${title}"`);
        const upsert = await HumanRequest.findOneAndUpdate(
          { runId: scope.run._id, stepKey: key },
          {
            $setOnInsert: {
              workspaceId: scope.run.workspaceId,
              runId: scope.run._id,
              processId: definition.id,
              runNumber: scope.run.number,
              stepKey: key,
              kind,
              title,
              description: request.description,
              payload,
              dataSchema: request.schema
                ? z.toJSONSchema(request.schema, { unrepresentable: "any" })
                : undefined,
              assignees: request.assignees ?? [],
              status: "pending",
              expiresAt,
              versionId: new Types.ObjectId(scope.versionId),
            },
          },
          { upsert: true, new: true, includeResultMetadata: true },
        );
        const doc = upsert.value as IHumanRequest;
        const created = !upsert.lastErrorObject?.updatedExisting;
        if (created) {
          await append(journal, {
            type: "step.started",
            stepKey: key,
            data: { name: title, kind, attempt: 0 },
          });
          await append(journal, {
            type: "human.requested",
            stepKey: key,
            dedupeKey: `human.requested:${key}`,
            data: {
              requestId: doc._id.toString(),
              kind,
              title,
              payload,
              assignees: doc.assignees,
              expiresAt: doc.expiresAt.toISOString(),
            },
          });
        }
        if (doc.status === "pending") {
          await setWaiting({
            kind,
            stepKey: key,
            title,
            until: doc.expiresAt,
            requestId: doc._id.toString(),
          });
        }
        return {
          requestId: doc._id.toString(),
          expiresAt: doc.expiresAt.toISOString(),
        };
      },
      HOUSEKEEPING,
    );
    if ("memo" in opened) return opened.memo as R;

    const decision = await driver.waitForSignal(`${key}:wait`, {
      signalKey: key,
      timeoutAt: new Date(opened.expiresAt),
      check: () => readDecision(opened.requestId),
    });

    return driver.run(
      `${key}:resume`,
      async () => {
        const cached = await memo<R>(key);
        if (cached) return cached.output;
        let final = decision;
        if (!final) {
          // Timed out: expire atomically — unless a decision raced in.
          const expired = await HumanRequest.findOneAndUpdate(
            { _id: opened.requestId, status: "pending" },
            { $set: { status: "expired" } },
            { new: true },
          ).lean();
          if (expired) {
            await append(journal, {
              type: "human.expired",
              stepKey: key,
              dedupeKey: `human.expired:${key}`,
              data: { requestId: opened.requestId, title },
            });
          }
          final = (await readDecision(opened.requestId)) ?? {
            status: "expired",
          };
        }
        if (final.status === "cancelled") throw new RunCancelledError();
        const result = finish(final);
        const output = await complete(key, title, kind, result);
        await setRunning(key);
        return output;
      },
      HOUSEKEEPING,
    );
  }

  // ── waits ────────────────────────────────────────────────────────────────
  async function wait(name: string, spec: WaitSpec): Promise<unknown> {
    const key = nextKey(name);
    const isEvent = "event" in spec;
    const plan = await driver.run(
      `${key}:start`,
      async () => {
        const cached = await memo<unknown>(key);
        if (cached) return { memo: cached.output };
        await assertActive();
        const now = deps.now().getTime();
        const until = isEvent
          ? new Date(now + toMs(spec.timeout ?? DEFAULT_EVENT_TIMEOUT))
          : "until" in spec
            ? new Date(spec.until)
            : new Date(now + toMs(spec.for));
        if (Number.isNaN(until.getTime())) {
          throw new NonRetryableStepError(
            `Invalid wait deadline for "${name}"`,
          );
        }
        const first = await append(journal, {
          type: "wait.started",
          stepKey: key,
          dedupeKey: `wait.started:${key}`,
          data: {
            name,
            until: until.toISOString(),
            ...(isEvent ? { event: spec.event, match: spec.match ?? {} } : {}),
          },
        });
        if (first.inserted) {
          await append(journal, {
            type: "step.started",
            stepKey: key,
            data: { name, kind: "wait", attempt: 0 },
          });
        }
        const started = await findByDedupeKey(runId, `wait.started:${key}`);
        const deadline = new Date(String(started?.data.until ?? until));
        await setWaiting({
          kind: isEvent ? "event" : "sleep",
          stepKey: key,
          title: name,
          until: deadline,
          ...(isEvent ? { event: spec.event, match: spec.match ?? {} } : {}),
        });
        return { until: deadline.toISOString() };
      },
      HOUSEKEEPING,
    );
    if ("memo" in plan) return plan.memo;

    let payload: unknown = null;
    if (isEvent) {
      payload = await driver.waitForSignal(`${key}:wait`, {
        signalKey: key,
        timeoutAt: new Date(plan.until),
        check: async () => {
          const matched = await findByDedupeKey(runId, `wait.matched:${key}`);
          return matched ? (matched.data.payload ?? {}) : null;
        },
      });
    } else {
      await driver.sleepUntil(`${key}:sleep`, new Date(plan.until));
    }

    return driver.run(
      `${key}:resume`,
      async () => {
        const cached = await memo<unknown>(key);
        if (cached) return cached.output;
        await assertActive();
        await append(journal, {
          type: "wait.completed",
          stepKey: key,
          dedupeKey: `wait.completed:${key}`,
          data: { name, timedOut: isEvent && payload === null },
        });
        const output = await complete(
          key,
          name,
          "wait",
          isEvent ? payload : null,
        );
        await setRunning(key);
        return output;
      },
      HOUSEKEEPING,
    );
  }

  // ── the context ──────────────────────────────────────────────────────────
  const runInfo: RunInfo = {
    id: runId,
    number: scope.run.number,
    processId: definition.id,
    workspaceId,
    trigger: scope.run.trigger,
  };

  const ctx: ProcessContext = {
    run: runInfo,

    step<T>(
      name: string,
      fn: (s: StepContext) => Promise<T>,
      options?: StepOptions,
    ): Promise<T> {
      const key = nextKey(name);
      return runStep(
        key,
        name,
        "step",
        {
          retries: options?.retries ?? DEFAULT_STEP_RETRIES,
          timeout: options?.timeout ?? DEFAULT_STEP_TIMEOUT,
        },
        s => fn(s),
      );
    },

    agent<T>(name: string, spec: AgentSpec<T>): Promise<T> {
      const key = nextKey(name);
      const allowed = new Set(spec.allowEffects ?? ["read"]);
      for (const tool of spec.tools ?? []) {
        if (envelope.get(tool.name) !== tool) {
          return Promise.reject(
            new ProcessStepError(
              key,
              name,
              `Tool "${tool.name}" is not in the process tool envelope`,
            ),
          );
        }
        if (tool.effect === "destructive" || !allowed.has(tool.effect)) {
          return Promise.reject(
            new ProcessStepError(
              key,
              name,
              `Agents may not use ${tool.effect} tool "${tool.name}"` +
                (tool.effect === "write"
                  ? ' (opt in with allowEffects: ["read", "write"])'
                  : " — run destructive actions in ctx.step after an approval"),
            ),
          );
        }
      }
      return runStep(
        key,
        name,
        "agent",
        {
          retries: spec.retries ?? DEFAULT_AGENT_RETRIES,
          timeout: spec.timeout ?? DEFAULT_AGENT_TIMEOUT,
        },
        async (_s, signal) => {
          const harness = spec.harness ?? deps.defaultHarness();
          const model = spec.model ?? (await deps.defaultModel());
          const prompt =
            typeof spec.prompt === "string"
              ? spec.prompt
              : JSON.stringify(spec.prompt, null, 2);
          const tools: RuntimeTool[] = (spec.tools ?? []).map(tool => ({
            name: modelToolName(tool.name),
            description: tool.description,
            inputSchema: tool.input,
            inputJsonSchema: z.toJSONSchema(tool.input, {
              unrepresentable: "any",
            }) as Record<string, unknown>,
            invoke: (input, meta) =>
              invokeTool(tool, input, {
                callKey: `${key}:i${meta.iteration}:${meta.callId}`,
                stepKey: key,
                caller: "agent",
                iteration: meta.iteration,
              }),
          }));
          const limits = {
            maxIterations: spec.maxIterations ?? 20,
            maxToolCalls: spec.maxToolCalls ?? 50,
            timeoutMs: toMs(spec.timeout ?? DEFAULT_AGENT_TIMEOUT),
          };
          await append(journal, {
            type: "agent.started",
            stepKey: key,
            dedupeKey: `agent.started:${key}`,
            data: {
              harness: harness.id,
              model,
              instructions: spec.instructions,
              prompt: capForDisplay(prompt),
              tools: (spec.tools ?? []).map(t => ({
                name: t.name,
                effect: t.effect,
              })),
              limits,
            },
          });
          const result = await harness.run(
            {
              workspaceId,
              runId,
              stepKey: key,
              model,
              instructions: spec.instructions,
              prompt,
              tools,
              output: spec.output,
              outputJsonSchema: z.toJSONSchema(spec.output, {
                unrepresentable: "any",
              }) as Record<string, unknown>,
              limits,
              signal,
            },
            {
              emitTurn: async (turn: AgentTurn) => {
                let messages = turn.messages;
                if (messages && JSON.stringify(messages).length > 900_000) {
                  messages = undefined; // too big to checkpoint; trace only
                }
                await append(journal, {
                  type: "agent.turn",
                  stepKey: key,
                  data: {
                    ...turn,
                    messages,
                    text: turn.text,
                    toolCalls: turn.toolCalls.map(c => ({
                      ...c,
                      input: capForDisplay(c.input),
                      output: capForDisplay(c.output),
                    })),
                  } as unknown as Record<string, unknown>,
                });
                await ProcessRun.updateOne(
                  { _id: scope.run._id },
                  {
                    $inc: {
                      "usage.modelCalls": 1,
                      "usage.inputTokens": turn.usage?.inputTokens ?? 0,
                      "usage.outputTokens": turn.usage?.outputTokens ?? 0,
                      "usage.costUsd": turn.usage?.costUsd ?? 0,
                    },
                  },
                );
              },
              previousTurns: async () =>
                (
                  await listEvents(runId, { stepKey: key, type: "agent.turn" })
                ).map(e => e.data as unknown as AgentTurn),
            },
          );
          const output = spec.output.parse(result.output);
          await append(journal, {
            type: "agent.completed",
            stepKey: key,
            data: {
              iterations: result.iterations,
              toolCalls: result.toolCalls,
              usage: result.usage,
              model,
            },
          });
          return output;
        },
      );
    },

    approval<T>(
      title: string,
      spec: ApprovalSpec<T>,
    ): Promise<ApprovalResult<T>> {
      return human(
        "approval",
        title,
        spec.schema
          ? { ...spec, payload: spec.data }
          : { ...spec, schema: undefined, payload: spec.data },
        decision => {
          const at = decision?.respondedAt ?? deps.now().toISOString();
          if (!decision || decision.status === "expired") {
            return {
              approved: false,
              outcome: "expired" as const,
              data: spec.data,
              at,
            };
          }
          const approved = decision.status === "approved";
          let data = spec.data;
          if (approved && decision.response?.edited && spec.schema) {
            const parsed = spec.schema.safeParse(decision.response.data);
            if (!parsed.success) {
              throw new NonRetryableStepError(
                `Edited data for "${title}" failed validation: ${z.prettifyError(parsed.error)}`,
              );
            }
            data = parsed.data;
          }
          return {
            approved,
            outcome: approved ? ("approved" as const) : ("rejected" as const),
            data,
            comment: decision.response?.comment,
            by: decision.respondedBy ?? undefined,
            at,
          };
        },
      ).then(
        result => toJson(result, `Result of "${title}"`) as ApprovalResult<T>,
      );
    },

    task<T extends Record<string, unknown>>(
      title: string,
      spec: TaskSpec<T>,
    ): Promise<TaskResult<T>> {
      return human(
        "task",
        title,
        { ...spec, schema: spec.form, payload: spec.prefill ?? {} },
        decision => {
          if (!decision || decision.status !== "submitted") {
            return { expired: true as const };
          }
          const parsed = spec.form.safeParse(decision.response?.data);
          if (!parsed.success) {
            throw new NonRetryableStepError(
              `Submitted form for "${title}" failed validation: ${z.prettifyError(parsed.error)}`,
            );
          }
          return {
            data: parsed.data,
            by: decision.respondedBy ?? undefined,
            at: decision.respondedAt ?? deps.now().toISOString(),
          };
        },
      ).then(result => {
        if ("expired" in result) throw new HumanRequestExpiredError(title);
        return result as TaskResult<T>;
      });
    },

    wait: ((name: string, spec: WaitSpec) =>
      wait(name, spec)) as ProcessContext["wait"],
  };

  return ctx;
}
