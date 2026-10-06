/**
 * Process service — everything outside a run: install/configure, start,
 * cancel, retry, human responses, business events, schedules, read models.
 *
 * Routes call this; engines call `executeRun`. All queries are scoped by
 * workspaceId.
 */
import { Types } from "mongoose";
import { z } from "zod";
import { getProcessDefinition, listProcessDefinitions } from "./registry";
import type { ProcessDefinition, TriggerSpec } from "./sdk";
import {
  HumanRequest,
  ProcessEvent,
  ProcessInstallation,
  ProcessRun,
  ProcessVersion,
  TERMINAL_STATUSES,
  type IHumanRequest,
  type IProcessRun,
  type RunTrigger,
  type RunStatus,
} from "./runtime/models";
import { append, errorMessage } from "./runtime/journal";
import { ensureVersion, buildManifest } from "./runtime/version";
import { projectRun, type JournalEvent } from "./runtime/project";
import { getExecutionEngine } from "./runtime/engine";
import { getRuntimeDeps } from "./runtime/deps";
import { isCronDue } from "../services/cron-due";
import { workspaceService } from "../services/workspace.service";
import { loggers } from "../logging";

const log = loggers.inngest("processes");

export class ProcessServiceError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404 | 409,
  ) {
    super(message);
    this.name = "ProcessServiceError";
  }
}

const oid = (id: string) => {
  if (!Types.ObjectId.isValid(id)) {
    throw new ProcessServiceError("Invalid id", 400);
  }
  return new Types.ObjectId(id);
};

function requireDefinition(processId: string): ProcessDefinition {
  const definition = getProcessDefinition(processId);
  if (!definition)
    throw new ProcessServiceError(`Unknown process "${processId}"`, 404);
  return definition;
}

async function getInstallation(workspaceId: string, processId: string) {
  return ProcessInstallation.findOneAndUpdate(
    { workspaceId: oid(workspaceId), processId },
    {
      $setOnInsert: {
        workspaceId: oid(workspaceId),
        processId,
        enabled: false,
        bindings: {},
        runCounter: 0,
        versionCounter: 0,
        lastScheduledAt: {},
      },
    },
    { upsert: true, new: true },
  ).lean();
}

function connectionSlots(definition: ProcessDefinition): string[] {
  return [
    ...new Set(
      (definition.tools ?? []).flatMap(t => [...(t.connections ?? [])]),
    ),
  ];
}

// ── read models ────────────────────────────────────────────────────────────

export function serializeRun(run: IProcessRun) {
  return {
    id: run._id.toString(),
    processId: run.processId,
    number: run.number,
    status: run.status,
    waitingOn: run.waitingOn ?? null,
    versionId: run.versionId.toString(),
    versionNumber: run.versionNumber,
    trigger: run.trigger,
    input: run.input,
    output: run.output ?? null,
    error: run.error ?? null,
    usage: run.usage,
    attempt: run.attempt,
    createdAt: run.createdAt,
    startedAt: run.startedAt ?? null,
    endedAt: run.endedAt ?? null,
  };
}

export async function listProcesses(workspaceId: string) {
  const definitions = listProcessDefinitions();
  const installations = await ProcessInstallation.find({
    workspaceId: oid(workspaceId),
  }).lean();
  const stats = await ProcessRun.aggregate<{
    _id: string;
    total: number;
    completed: number;
    failed: number;
    active: number;
    waiting: number;
  }>([
    { $match: { workspaceId: oid(workspaceId) } },
    {
      $group: {
        _id: "$processId",
        total: { $sum: 1 },
        completed: {
          $sum: { $cond: [{ $eq: ["$status", "completed"] }, 1, 0] },
        },
        failed: { $sum: { $cond: [{ $eq: ["$status", "failed"] }, 1, 0] } },
        active: {
          $sum: { $cond: [{ $in: ["$status", ["queued", "running"]] }, 1, 0] },
        },
        waiting: { $sum: { $cond: [{ $eq: ["$status", "waiting"] }, 1, 0] } },
      },
    },
  ]);
  const lastRuns = await ProcessRun.aggregate<{
    _id: string;
    run: IProcessRun;
  }>([
    { $match: { workspaceId: oid(workspaceId) } },
    { $sort: { createdAt: -1 } },
    { $group: { _id: "$processId", run: { $first: "$$ROOT" } } },
  ]);
  return definitions.map(definition => {
    const installation = installations.find(i => i.processId === definition.id);
    const stat = stats.find(s => s._id === definition.id);
    const last = lastRuns.find(r => r._id === definition.id)?.run;
    const finished = (stat?.completed ?? 0) + (stat?.failed ?? 0);
    return {
      id: definition.id,
      name: definition.name,
      description: definition.description ?? "",
      category: definition.category ?? null,
      triggers: definition.triggers,
      enabled: installation?.enabled ?? false,
      runs: {
        total: stat?.total ?? 0,
        active: stat?.active ?? 0,
        waiting: stat?.waiting ?? 0,
        failed: stat?.failed ?? 0,
        successRate: finished ? (stat?.completed ?? 0) / finished : null,
      },
      lastRun: last ? serializeRun(last) : null,
    };
  });
}

export async function getProcessDetail(workspaceId: string, processId: string) {
  const definition = requireDefinition(processId);
  const version = await ensureVersion(definition);
  const [versionDoc, installation, versions] = await Promise.all([
    ProcessVersion.findById(version.id).lean(),
    getInstallation(workspaceId, processId),
    ProcessVersion.find({ processId })
      .sort({ number: -1 })
      .limit(20)
      .select("number hash createdAt firstSeenBuild")
      .lean(),
  ]);
  return {
    id: definition.id,
    name: definition.name,
    description: definition.description ?? "",
    category: definition.category ?? null,
    manifest: buildManifest(definition),
    connectionSlots: connectionSlots(definition),
    currentVersion: {
      id: version.id,
      number: version.number,
      hash: version.hash,
      outline: versionDoc?.outline ?? [],
      source: versionDoc?.source ?? "",
    },
    versions: versions.map(v => ({
      id: v._id.toString(),
      number: v.number,
      hash: v.hash,
      createdAt: v.createdAt,
      firstSeenBuild: v.firstSeenBuild ?? null,
    })),
    installation: {
      enabled: installation?.enabled ?? false,
      bindings: installation?.bindings ?? {},
    },
  };
}

export async function updateInstallation(
  workspaceId: string,
  processId: string,
  patch: { enabled?: boolean; bindings?: Record<string, string> },
  userId: string,
) {
  const definition = requireDefinition(processId);
  await getInstallation(workspaceId, processId);
  const set: Record<string, unknown> = { updatedBy: userId };
  if (patch.enabled !== undefined) {
    set.enabled = patch.enabled;
    if (patch.enabled) {
      // Schedules start counting from now, not from the epoch.
      definition.triggers.forEach((t, i) => {
        if (t.type === "schedule") {
          set[`lastScheduledAt.s${i}`] = getRuntimeDeps().now();
        }
      });
    }
  }
  if (patch.bindings) {
    const slots = connectionSlots(definition);
    for (const slot of Object.keys(patch.bindings)) {
      if (!slots.includes(slot)) {
        throw new ProcessServiceError(`Unknown connection slot "${slot}"`, 400);
      }
    }
    set.bindings = patch.bindings;
  }
  await ProcessInstallation.updateOne(
    { workspaceId: oid(workspaceId), processId },
    { $set: set },
  );
  return getProcessDetail(workspaceId, processId);
}

// ── runs ───────────────────────────────────────────────────────────────────

export interface StartRunInput {
  workspaceId: string;
  processId: string;
  input: unknown;
  trigger: RunTrigger;
  idempotencyKey?: string;
}

export async function startRun(params: StartRunInput) {
  const definition = requireDefinition(params.processId);
  const parsed = definition.input.safeParse(params.input ?? {});
  if (!parsed.success) {
    throw new ProcessServiceError(
      `Invalid input: ${z.prettifyError(parsed.error)}`,
      400,
    );
  }
  if (params.idempotencyKey) {
    const existing = await ProcessRun.findOne({
      workspaceId: oid(params.workspaceId),
      processId: params.processId,
      idempotencyKey: params.idempotencyKey,
    }).lean();
    if (existing) return { run: serializeRun(existing), deduplicated: true };
  }
  const version = await ensureVersion(definition);
  await getInstallation(params.workspaceId, params.processId);
  const installation = await ProcessInstallation.findOneAndUpdate(
    { workspaceId: oid(params.workspaceId), processId: params.processId },
    { $inc: { runCounter: 1 } },
    { new: true },
  ).lean();

  let run: IProcessRun;
  try {
    run = (
      await ProcessRun.create({
        workspaceId: oid(params.workspaceId),
        processId: params.processId,
        number: installation?.runCounter ?? 1,
        versionId: new Types.ObjectId(version.id),
        versionNumber: version.number,
        status: "queued",
        input: parsed.data,
        trigger: params.trigger,
        ...(params.idempotencyKey
          ? { idempotencyKey: params.idempotencyKey }
          : {}),
      })
    ).toObject();
  } catch (error) {
    if ((error as { code?: number }).code === 11000 && params.idempotencyKey) {
      const existing = await ProcessRun.findOne({
        workspaceId: oid(params.workspaceId),
        processId: params.processId,
        idempotencyKey: params.idempotencyKey,
      }).lean();
      if (existing) return { run: serializeRun(existing), deduplicated: true };
    }
    throw error;
  }

  await append(
    {
      runId: run._id.toString(),
      workspaceId: params.workspaceId,
      versionId: version.id,
    },
    {
      type: "run.created",
      dedupeKey: "run.created",
      data: {
        trigger: params.trigger,
        input: parsed.data,
        version: version.number,
      },
    },
  );
  await getExecutionEngine().enqueue(run._id.toString(), {
    workspaceId: params.workspaceId,
  });
  return { run: serializeRun(run), deduplicated: false };
}

export async function listRuns(
  workspaceId: string,
  filter: { processId?: string; status?: RunStatus; limit?: number },
) {
  const runs = await ProcessRun.find({
    workspaceId: oid(workspaceId),
    ...(filter.processId ? { processId: filter.processId } : {}),
    ...(filter.status ? { status: filter.status } : {}),
  })
    .sort({ createdAt: -1 })
    .limit(Math.min(filter.limit ?? 50, 200))
    .lean();
  return runs.map(serializeRun);
}

async function loadRun(workspaceId: string, runId: string) {
  const run = await ProcessRun.findOne({
    _id: oid(runId),
    workspaceId: oid(workspaceId),
  }).lean();
  if (!run) throw new ProcessServiceError("Run not found", 404);
  return run;
}

export async function getRunDetail(workspaceId: string, runId: string) {
  const run = await loadRun(workspaceId, runId);
  const [events, requests, version] = await Promise.all([
    ProcessEvent.find({ runId: run._id }).sort({ ts: 1, _id: 1 }).lean(),
    HumanRequest.find({ runId: run._id }).lean(),
    ProcessVersion.findById(run.versionId).select("number hash outline").lean(),
  ]);
  const journal: JournalEvent[] = events.map(e => ({
    id: e._id.toString(),
    ts: e.ts.toISOString(),
    type: e.type,
    stepKey: e.stepKey,
    versionId: e.versionId?.toString(),
    data: e.data,
  }));
  const definition = getProcessDefinition(run.processId);
  const current = definition ? await ensureVersion(definition) : null;
  return {
    run: serializeRun(run),
    processName: definition?.name ?? run.processId,
    version: {
      id: run.versionId.toString(),
      number: run.versionNumber,
      outline: version?.outline ?? [],
      current: current ? { id: current.id, number: current.number } : null,
    },
    steps: projectRun(journal),
    // Timeline: the journal minus heavy/internal payloads.
    events: journal.map(e => ({
      ...e,
      data:
        e.type === "agent.turn"
          ? {
              iteration: e.data.iteration,
              model: e.data.model,
              usage: e.data.usage,
            }
          : e.type === "artifact.created"
            ? { name: e.data.name, mimeType: e.data.mimeType }
            : e.data,
    })),
    humanRequests: requests.map(serializeHumanRequest),
  };
}

export async function getArtifact(
  workspaceId: string,
  runId: string,
  eventId: string,
) {
  const run = await loadRun(workspaceId, runId);
  const event = await ProcessEvent.findOne({
    _id: oid(eventId),
    runId: run._id,
    type: "artifact.created",
  }).lean();
  if (!event) throw new ProcessServiceError("Artifact not found", 404);
  return {
    name: String(event.data.name),
    mimeType: String(event.data.mimeType ?? "text/plain"),
    content: String(event.data.content ?? ""),
  };
}

export async function cancelRun(
  workspaceId: string,
  runId: string,
  userId: string,
) {
  const run = await loadRun(workspaceId, runId);
  const updated = await ProcessRun.updateOne(
    { _id: run._id, status: { $nin: TERMINAL_STATUSES } },
    { $set: { status: "cancelled", waitingOn: null, endedAt: new Date() } },
  );
  if (updated.modifiedCount === 0) {
    throw new ProcessServiceError(`Run is already ${run.status}`, 409);
  }
  await HumanRequest.updateMany(
    { runId: run._id, status: "pending" },
    { $set: { status: "cancelled" } },
  );
  await append(
    { runId, workspaceId, versionId: run.versionId.toString() },
    { type: "run.cancelled", dedupeKey: "run.cancelled", data: { by: userId } },
  );
  await getExecutionEngine().cancel(runId);
  return serializeRun((await loadRun(workspaceId, runId)) as IProcessRun);
}

/**
 * Re-queue a FAILED run. Everything the journal memoized (completed steps,
 * decided approvals, finished tool calls) is reused; execution resumes at the
 * step that failed.
 */
export async function retryRun(
  workspaceId: string,
  runId: string,
  userId: string,
) {
  const run = await loadRun(workspaceId, runId);
  const updated = await ProcessRun.updateOne(
    { _id: run._id, status: "failed" },
    {
      $set: { status: "queued", error: null, endedAt: null },
      $inc: { attempt: 1 },
    },
  );
  if (updated.modifiedCount === 0) {
    throw new ProcessServiceError("Only failed runs can be retried", 409);
  }
  await append(
    { runId, workspaceId, versionId: run.versionId.toString() },
    {
      type: "run.retried",
      dedupeKey: `run.retried:${run.attempt + 1}`,
      data: { by: userId, attempt: run.attempt + 1 },
    },
  );
  await getExecutionEngine().enqueue(runId, { workspaceId });
  return serializeRun((await loadRun(workspaceId, runId)) as IProcessRun);
}

// ── human requests ─────────────────────────────────────────────────────────

export function serializeHumanRequest(request: IHumanRequest) {
  return {
    id: request._id.toString(),
    runId: request.runId.toString(),
    processId: request.processId,
    processName:
      getProcessDefinition(request.processId)?.name ?? request.processId,
    runNumber: request.runNumber,
    stepKey: request.stepKey,
    kind: request.kind,
    title: request.title,
    description: request.description ?? null,
    payload: request.payload,
    schema: request.dataSchema ?? null,
    assignees: request.assignees,
    status: request.status,
    response: request.response ?? null,
    respondedBy: request.respondedBy ?? null,
    respondedAt: request.respondedAt ?? null,
    expiresAt: request.expiresAt,
    createdAt: request.createdAt,
  };
}

export async function listHumanRequests(
  workspaceId: string,
  filter: { status?: "pending" | "decided"; limit?: number },
) {
  const statusFilter =
    filter.status === "pending"
      ? { status: "pending" }
      : filter.status === "decided"
        ? { status: { $ne: "pending" } }
        : {};
  const requests = await HumanRequest.find({
    workspaceId: oid(workspaceId),
    ...statusFilter,
  })
    .sort({ createdAt: -1 })
    .limit(Math.min(filter.limit ?? 100, 500))
    .lean();
  return requests.map(serializeHumanRequest);
}

export async function canRespond(
  request: Pick<IHumanRequest, "assignees" | "workspaceId">,
  user: { id: string; email: string },
): Promise<boolean> {
  if (request.assignees.length > 0) {
    const who = new Set([user.id, user.email.toLowerCase()]);
    return request.assignees.some(a => who.has(a.toLowerCase()) || who.has(a));
  }
  return workspaceService.isAdmin(request.workspaceId.toString(), user.id);
}

export interface HumanResponse {
  decision: "approve" | "reject" | "submit";
  data?: unknown;
  comment?: string;
}

export async function respondToHumanRequest(
  workspaceId: string,
  requestId: string,
  user: { id: string; email: string },
  response: HumanResponse,
) {
  const request = await HumanRequest.findOne({
    _id: oid(requestId),
    workspaceId: oid(workspaceId),
  }).lean();
  if (!request) throw new ProcessServiceError("Request not found", 404);
  if (request.status !== "pending") {
    throw new ProcessServiceError(`Request is already ${request.status}`, 409);
  }
  if (!(await canRespond(request, user))) {
    throw new ProcessServiceError(
      request.assignees.length
        ? "Only the assignees of this request can respond"
        : "Only workspace admins can respond to this request",
      403,
    );
  }

  const valid =
    request.kind === "approval"
      ? response.decision === "approve" || response.decision === "reject"
      : response.decision === "submit";
  if (!valid) {
    throw new ProcessServiceError(
      `"${response.decision}" is not a valid response to a ${request.kind}`,
      400,
    );
  }

  let edited = false;
  let data: unknown;
  const needsData =
    request.kind === "task" ||
    (response.decision === "approve" && response.data !== undefined);
  if (needsData) {
    if (!request.dataSchema) {
      throw new ProcessServiceError("This approval does not allow edits", 400);
    }
    try {
      const schema = z.fromJSONSchema(
        request.dataSchema as Parameters<typeof z.fromJSONSchema>[0],
      );
      const parsed = schema.safeParse(response.data);
      if (!parsed.success) {
        throw new ProcessServiceError(
          `Invalid data: ${z.prettifyError(parsed.error)}`,
          400,
        );
      }
    } catch (error) {
      if (error instanceof ProcessServiceError) throw error;
      log.warn("Could not compile human request schema; skipping validation", {
        requestId,
        error: errorMessage(error),
      });
    }
    data = response.data;
    edited =
      request.kind === "approval" &&
      JSON.stringify(response.data) !== JSON.stringify(request.payload);
  }

  const status =
    response.decision === "approve"
      ? "approved"
      : response.decision === "reject"
        ? "rejected"
        : "submitted";
  const respondedBy = { id: user.id, email: user.email };
  const updated = await HumanRequest.findOneAndUpdate(
    { _id: request._id, status: "pending" },
    {
      $set: {
        status,
        response: {
          ...(data !== undefined ? { data } : {}),
          ...(response.comment ? { comment: response.comment } : {}),
          edited,
        },
        respondedBy,
        respondedAt: new Date(),
      },
    },
    { new: true },
  ).lean();
  if (!updated)
    throw new ProcessServiceError("Request was decided concurrently", 409);

  await append(
    {
      runId: request.runId.toString(),
      workspaceId,
      versionId: request.versionId.toString(),
    },
    {
      type: "human.responded",
      stepKey: request.stepKey,
      dedupeKey: `human.responded:${request.stepKey}`,
      data: {
        requestId,
        status,
        by: respondedBy,
        comment: response.comment ?? null,
        edited,
        ...(edited ? { data: capPayload(data) } : {}),
      },
    },
  );
  await getExecutionEngine().signal(request.runId.toString(), request.stepKey);
  return serializeHumanRequest(updated);
}

function capPayload(value: unknown): unknown {
  const text = JSON.stringify(value);
  return text && text.length > 64_000 ? { truncated: true } : value;
}

// ── business events ────────────────────────────────────────────────────────

function matches(match: unknown, data: Record<string, unknown>): boolean {
  if (!match || typeof match !== "object") return true;
  return Object.entries(match as Record<string, unknown>).every(
    ([key, value]) => data[key] === value,
  );
}

/**
 * A business event happened in the workspace. Starts every ENABLED process
 * triggered by it and wakes every run waiting on it (`ctx.wait({ event })`).
 */
export async function emitProcessEvent(
  workspaceId: string,
  name: string,
  data: Record<string, unknown>,
  options: { idempotencyKey?: string; by?: string } = {},
) {
  const started: string[] = [];
  const installations = await ProcessInstallation.find({
    workspaceId: oid(workspaceId),
    enabled: true,
  }).lean();
  for (const installation of installations) {
    const definition = getProcessDefinition(installation.processId);
    const triggered = definition?.triggers.some(
      (t: TriggerSpec) => t.type === "event" && t.event === name,
    );
    if (!definition || !triggered) continue;
    try {
      const { run } = await startRun({
        workspaceId,
        processId: definition.id,
        input: data,
        trigger: {
          type: "event",
          event: name,
          ...(options.by ? { by: options.by } : {}),
        },
        ...(options.idempotencyKey
          ? { idempotencyKey: `event:${name}:${options.idempotencyKey}` }
          : {}),
      });
      started.push(run.id);
    } catch (error) {
      log.warn("Event-triggered process did not start", {
        workspaceId,
        processId: definition.id,
        event: name,
        error: errorMessage(error),
      });
    }
  }

  const delivered: string[] = [];
  const waiting = await ProcessRun.find({
    workspaceId: oid(workspaceId),
    status: "waiting",
    "waitingOn.kind": "event",
    "waitingOn.event": name,
  }).lean();
  for (const run of waiting) {
    if (!run.waitingOn || !matches(run.waitingOn.match, data)) continue;
    const { inserted } = await append(
      {
        runId: run._id.toString(),
        workspaceId,
        versionId: run.versionId.toString(),
      },
      {
        type: "wait.matched",
        stepKey: run.waitingOn.stepKey,
        dedupeKey: `wait.matched:${run.waitingOn.stepKey}`,
        data: { event: name, payload: data },
      },
    );
    if (inserted) {
      await getExecutionEngine().signal(
        run._id.toString(),
        run.waitingOn.stepKey,
      );
      delivered.push(run._id.toString());
    }
  }
  return { started, delivered };
}

// ── schedules ──────────────────────────────────────────────────────────────

/** One scheduler tick: start every due schedule trigger exactly once. */
export async function runDueSchedules(now = new Date()): Promise<number> {
  let startedCount = 0;
  for (const definition of listProcessDefinitions()) {
    const schedules = definition.triggers
      .map((t, i) => ({ t, slot: `s${i}` }))
      .filter(
        (
          x,
        ): x is {
          t: Extract<TriggerSpec, { type: "schedule" }>;
          slot: string;
        } => x.t.type === "schedule",
      );
    if (schedules.length === 0) continue;
    const installations = await ProcessInstallation.find({
      processId: definition.id,
      enabled: true,
    }).lean();
    for (const installation of installations) {
      for (const { t, slot } of schedules) {
        const last = installation.lastScheduledAt?.[slot] ?? null;
        let due = false;
        try {
          due = isCronDue({
            cron: t.cron,
            timezone: t.timezone,
            lastRunAt: last ? new Date(last) : installation.createdAt,
            now,
          });
        } catch (error) {
          log.warn("Invalid process schedule", {
            processId: definition.id,
            cron: t.cron,
            error: errorMessage(error),
          });
        }
        if (!due) continue;
        // Optimistic claim: only one scheduler instance wins this tick.
        const claimed = await ProcessInstallation.updateOne(
          {
            _id: installation._id,
            [`lastScheduledAt.${slot}`]: last ?? { $exists: false },
          },
          { $set: { [`lastScheduledAt.${slot}`]: now } },
        );
        if (claimed.modifiedCount === 0) continue;
        try {
          await startRun({
            workspaceId: installation.workspaceId.toString(),
            processId: definition.id,
            input: t.input ?? {},
            trigger: { type: "schedule" },
            idempotencyKey: `schedule:${slot}:${now.toISOString().slice(0, 16)}`,
          });
          startedCount++;
        } catch (error) {
          log.error("Scheduled process run failed to start", {
            processId: definition.id,
            workspaceId: installation.workspaceId.toString(),
            error: errorMessage(error),
          });
        }
      }
    }
  }
  return startedCount;
}

/** Pending approvals/tasks count, for the rail badge. */
export async function countPendingHumanRequests(workspaceId: string) {
  return HumanRequest.countDocuments({
    workspaceId: oid(workspaceId),
    status: "pending",
  });
}
