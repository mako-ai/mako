/**
 * projectRun — fold the journal into the view the UI renders.
 *
 * Pure: events in, steps out. The run timeline needs no other storage, and
 * tests assert on exactly what the UI will show.
 */

export interface JournalEvent {
  id: string;
  ts: string;
  type: string;
  stepKey?: string;
  versionId?: string;
  data: Record<string, unknown>;
}

export interface StepToolCall {
  tool: string;
  effect: string;
  callKey: string;
  caller: string;
  iteration?: number;
  input?: unknown;
  output?: unknown;
  error?: string;
  status: "running" | "completed" | "failed";
  startedAt: string;
  durationMs?: number;
  reconciled?: boolean;
}

export interface StepView {
  key: string;
  name: string;
  kind: string;
  status: "running" | "waiting" | "completed" | "failed";
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  attempts: number;
  output?: unknown;
  error?: string;
  logs: Array<{ ts: string; message: string; data?: unknown; tool?: string }>;
  artifacts: Array<{
    id: string;
    name: string;
    mimeType: string;
    bytes: number;
  }>;
  tools: StepToolCall[];
  agent?: {
    harness?: string;
    model?: string;
    instructions?: string;
    prompt?: unknown;
    tools?: unknown;
    turns: Array<Record<string, unknown>>;
    iterations?: number;
    toolCalls?: number;
    usage?: unknown;
  };
  human?: {
    requestId?: string;
    expiresAt?: string;
  };
  wait?: { until?: string; event?: string; match?: unknown };
  versionIds: string[];
}

export function projectRun(events: JournalEvent[]): StepView[] {
  const steps = new Map<string, StepView>();
  const order: string[] = [];

  const ensure = (event: JournalEvent): StepView | null => {
    const key = event.stepKey;
    if (!key) return null;
    let step = steps.get(key);
    if (!step) {
      step = {
        key,
        name: String(event.data.name ?? event.data.title ?? key),
        kind: String(event.data.kind ?? "step"),
        status: "running",
        startedAt: event.ts,
        attempts: 0,
        logs: [],
        artifacts: [],
        tools: [],
        versionIds: [],
      };
      steps.set(key, step);
      order.push(key);
    }
    if (event.versionId && !step.versionIds.includes(event.versionId)) {
      step.versionIds.push(event.versionId);
    }
    return step;
  };

  for (const event of events) {
    const step = ensure(event);
    if (!step) continue;
    const d = event.data;
    switch (event.type) {
      case "step.started":
        step.name = String(d.name ?? step.name);
        step.kind = String(d.kind ?? step.kind);
        step.attempts = Math.max(step.attempts, Number(d.attempt ?? 0) + 1);
        if (step.status === "failed") step.status = "running";
        step.error = undefined;
        break;
      case "step.completed":
        step.status = "completed";
        step.output = d.output;
        step.endedAt = event.ts;
        step.durationMs =
          typeof d.durationMs === "number"
            ? d.durationMs
            : Date.parse(event.ts) - Date.parse(step.startedAt);
        break;
      case "step.failed":
        step.status = d.willRetry ? "running" : "failed";
        step.error = String(d.error ?? "failed");
        if (!d.willRetry) step.endedAt = event.ts;
        break;
      case "log":
        step.logs.push({
          ts: event.ts,
          message: String(d.message ?? ""),
          ...(d.data !== undefined ? { data: d.data } : {}),
          ...(d.tool ? { tool: String(d.tool) } : {}),
        });
        break;
      case "artifact.created": {
        // Latest attempt wins for a given artifact name.
        step.artifacts = step.artifacts.filter(a => a.name !== d.name);
        step.artifacts.push({
          id: event.id,
          name: String(d.name),
          mimeType: String(d.mimeType ?? "text/plain"),
          bytes: String(d.content ?? "").length,
        });
        break;
      }
      case "tool.started":
        step.tools.push({
          tool: String(d.tool),
          effect: String(d.effect),
          callKey: String(d.callKey),
          caller: String(d.caller),
          ...(typeof d.iteration === "number"
            ? { iteration: d.iteration }
            : {}),
          input: d.input,
          status: "running",
          startedAt: event.ts,
        });
        break;
      case "tool.completed":
      case "tool.failed": {
        const call = [...step.tools]
          .reverse()
          .find(t => t.callKey === d.callKey && t.status === "running");
        const target =
          call ??
          (() => {
            const created: StepToolCall = {
              tool: String(d.tool),
              effect: String(d.effect),
              callKey: String(d.callKey),
              caller: String(d.caller),
              status: "running",
              startedAt: event.ts,
            };
            step.tools.push(created);
            return created;
          })();
        target.status =
          event.type === "tool.completed" ? "completed" : "failed";
        if (event.type === "tool.completed") target.output = d.output;
        else target.error = String(d.error ?? "failed");
        if (typeof d.durationMs === "number") target.durationMs = d.durationMs;
        if (d.reconciled) target.reconciled = true;
        break;
      }
      case "agent.started":
        step.kind = "agent";
        step.agent = {
          harness: d.harness as string | undefined,
          model: d.model as string | undefined,
          instructions: d.instructions as string | undefined,
          prompt: d.prompt,
          tools: d.tools,
          turns: step.agent?.turns ?? [],
        };
        break;
      case "agent.turn": {
        step.agent ??= { turns: [] };
        const { messages: _messages, ...turn } = d;
        step.agent.turns.push({ ...turn, ts: event.ts });
        break;
      }
      case "agent.completed":
        step.agent ??= { turns: [] };
        step.agent.iterations = d.iterations as number | undefined;
        step.agent.toolCalls = d.toolCalls as number | undefined;
        step.agent.usage = d.usage;
        break;
      case "human.requested":
        step.kind = String(d.kind ?? step.kind);
        step.status = "waiting";
        step.human = {
          requestId: d.requestId as string | undefined,
          expiresAt: d.expiresAt as string | undefined,
        };
        break;
      case "wait.started":
        step.kind = "wait";
        step.status = "waiting";
        step.wait = {
          until: d.until as string | undefined,
          ...(d.event ? { event: String(d.event), match: d.match } : {}),
        };
        break;
      default:
        break;
    }
  }

  return order.map(key => steps.get(key) as StepView);
}
