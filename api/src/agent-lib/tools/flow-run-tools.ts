/**
 * Flow operations over MCP: the flow's page in the UI, minus the browser.
 *
 * `check_flow_files` covers a flow's DEFINITION (`flows/<slug>.yml`). These
 * cover what happens to a defined flow afterwards, which until now only the
 * CDC Pipeline page and its Run History tab could show or do:
 *
 *   - reads (`list_flows`, `inspect_flow`, `list_flow_runs`): stream and
 *     backfill state, per-entity progress, the last error, recent executions.
 *     Read-only; like `probe_connection` they need query access, because run
 *     errors carry data from the platform behind the source. They never
 *     return a credential or the webhook secret, and every message that came
 *     from a run (an execution error, a log line, an entity's last failure)
 *     is scrubbed — before it is clipped — of the credentials of every
 *     connection the flow touches (the source's schema-secret fields, the
 *     database source's and the destination's credentials, passwords in
 *     connection strings) and of any `scheme://user:pass@` userinfo. Only
 *     that text is scrubbed: ids, slugs, entity names and keys are returned
 *     as they are.
 *   - writes (`flow_backfill`, `flow_stream`): the Start / Pause / Resume /
 *     Cancel buttons. Each calls the SAME `cdcBackfillService` method the
 *     route behind that button calls, and is at least as strict as that
 *     route: the route requires a live owner/admin; these require that AND
 *     the `sources-write` grant (scope `sources:write`).
 *
 * A flow is addressed by its id or by its file slug (`openai-ads-bigquery-
 * write`, or `flows/openai-ads-bigquery-write.yml`) — files at main are the
 * definition, so the same overlay the Flows list uses resolves both.
 */
import { tool } from "ai";
import { Types } from "mongoose";
import { z } from "zod";

import { redactSecrets } from "../../connectors/probe.service";
import {
  CdcEntityState,
  DatabaseConnection,
  FlowExecution,
  SourceConnection,
  type IFlow,
} from "../../database/workspace-schema";
import { loggers } from "../../logging";
import {
  liveFlowToPlain,
  loadLiveFlowById,
  loadLiveFlows,
  type LiveFlow,
} from "../../services/flow-sync.service";
import { cdcBackfillService } from "../../sync-cdc/backfill";
import { resolveConfiguredEntities } from "../../sync-cdc/entity-selection";
import { syncConnectorRegistry } from "../../sync/connector-registry";
import { sourceConnectionManager } from "../../sync/database-data-source-manager";
import { secretConfigValues } from "../../services/source-connection.service";
import {
  connectionCredentialValues,
  maskUriPasswords,
} from "../../utils/connection-secrets";
import { authorizeSourceWriter } from "./source-connection-tools";

const logger = loggers.api("flow-run-tools");

const DEFAULT_RUN_LIMIT = 10;
const MAX_RUN_LIMIT = 50;
/** Longest run-derived message returned, so one stack-like error cannot flood. */
const MAX_MESSAGE_CHARS = 1_000;

const flowRefInput = z
  .string()
  .min(1)
  .describe(
    "Flow id (from list_flows) or its file slug, e.g. `stripe-bigquery` or `flows/stripe-bigquery.yml`.",
  );

/** `flows/<slug>.yml` → `<slug>`; ids and bare slugs pass through. */
export function normalizeFlowRef(ref: string): string {
  return ref
    .trim()
    .replace(/^flows\//, "")
    .replace(/\.ya?ml$/, "");
}

const FLOW_NOT_FOUND =
  "Flow not found in this workspace (flows are the files under flows/ at main). Call list_flows for valid ids and slugs.";

/** Resolve an id or slug to the live flow (file at main + index row, if any). */
export async function resolveFlowRef(
  workspaceId: string,
  ref: string,
): Promise<{ ok: true; live: LiveFlow } | { ok: false; error: string }> {
  const key = normalizeFlowRef(ref);
  if (Types.ObjectId.isValid(key)) {
    const byId = await loadLiveFlowById(workspaceId, key);
    if (byId) return { ok: true, live: byId };
  }
  const live = await loadLiveFlows(workspaceId);
  const bySlug = live.find(item => item.def.slug === key);
  return bySlug
    ? { ok: true, live: bySlug }
    : { ok: false, error: FLOW_NOT_FOUND };
}

/** Shorter "secrets" would shred ordinary words; real credentials are longer. */
const MIN_SCRUB_CHARS = 4;

/** Scrub-then-clip for run-derived text; null for an empty value. */
export type RunTextScrubber = (value: unknown) => string | null;

/**
 * Redact FIRST, then clip. Clipping first would cut a credential that
 * straddles the limit and leave its head in clear, out of reach of the
 * redaction that runs on the full value.
 */
export function makeRunTextScrubber(
  secrets: readonly string[],
): RunTextScrubber {
  const known = secrets.filter(secret => secret.length >= MIN_SCRUB_CHARS);
  return (value: unknown) => {
    if (value === undefined || value === null || value === "") return null;
    const raw = typeof value === "string" ? value : JSON.stringify(value);
    const text = maskUriPasswords(redactSecrets(raw, known));
    return text.length > MAX_MESSAGE_CHARS
      ? `${text.slice(0, MAX_MESSAGE_CHARS)}… [truncated]`
      : text;
  };
}

/**
 * The credential values of every connection a flow touches, for scrubbing
 * its run-derived text: the source connection's SCHEMA-SECRET fields only
 * (an account id or an entity name in its config is not a credential), and
 * the credentials of the database source and the destination(s), passwords
 * embedded in connection strings included. Best effort per connection: one
 * that cannot be read is logged and contributes nothing, rather than failing
 * the read.
 */
async function flowCredentialValues(
  workspaceId: string,
  row: IFlow | null,
): Promise<string[]> {
  if (!row) return [];
  const found = new Set<string>();
  const warn = (what: string, error: unknown) =>
    logger.warn(`Could not load ${what} to scrub flow output`, {
      workspaceId,
      flowId: String(row._id),
      error: error instanceof Error ? error.message : String(error),
    });

  const sourceId = row.dataSourceId?.toString();
  if (sourceId) {
    try {
      const source =
        await sourceConnectionManager.getSourceConnection(sourceId);
      if (source && source.workspaceId === workspaceId) {
        const schema = await syncConnectorRegistry
          .getConfigSchemaForType(source.type, workspaceId)
          .catch(() => null);
        const values = Array.isArray(schema?.fields)
          ? secretConfigValues(source.connection, schema)
          : // No schema: fall back to the credential-NAMED keys, the rule
            // database connections are redacted by.
            connectionCredentialValues(source.connection);
        values.forEach(value => found.add(value));
      }
    } catch (error) {
      warn("source connection", error);
    }
  }

  const databaseIds = [
    row.databaseSource?.connectionId,
    row.destinationDatabaseId,
    row.tableDestination?.connectionId,
  ]
    .map(id => (id ? String(id) : ""))
    .filter(
      (id, index, all) =>
        id && Types.ObjectId.isValid(id) && all.indexOf(id) === index,
    );
  if (databaseIds.length > 0) {
    try {
      // Not `.lean()`: the model decrypts `connection` through a getter.
      const databases = await DatabaseConnection.find({
        _id: { $in: databaseIds.map(id => new Types.ObjectId(id)) },
        workspaceId: new Types.ObjectId(workspaceId),
      }).select("_id connection");
      for (const database of databases) {
        const connection = (
          database as unknown as {
            connection?: Record<string, unknown>;
          }
        ).connection;
        connectionCredentialValues(connection).forEach(value =>
          found.add(value),
        );
      }
    } catch (error) {
      warn("database connections", error);
    }
  }
  return [...found];
}

function idOf(value: unknown): string | null {
  if (!value) return null;
  return String(value);
}

type Plain = Record<string, unknown>;

/** The definition half of a flow, from the file overlaid on its row. */
function describeDefinition(plain: Plain, live: LiveFlow) {
  const databaseSource = plain.databaseSource as Plain | undefined;
  const table = plain.tableDestination as Plain | undefined;
  const schedule = plain.schedule as Plain | undefined;
  const backfillSchedule = plain.backfillSchedule as Plain | undefined;
  const invalid = plain.definitionInvalid as Plain | undefined;
  return {
    id: live.id.toString(),
    slug: live.def.slug,
    path: live.def.path,
    name: (plain.name as string | undefined) ?? live.def.slug,
    type: plain.type ?? null,
    syncEngine: plain.syncEngine ?? null,
    syncMode: plain.syncMode ?? null,
    writeMode: plain.writeMode ?? null,
    source: {
      type: plain.sourceType ?? null,
      connectionId:
        idOf(plain.dataSourceId) ?? idOf(databaseSource?.connectionId),
    },
    destination: {
      connectionId: idOf(plain.destinationDatabaseId),
      databaseName: plain.destinationDatabaseName ?? null,
      ...(table
        ? { schema: table.schema ?? null, table: table.tableName ?? null }
        : {}),
    },
    schedule: schedule
      ? {
          enabled: schedule.enabled === true,
          cron: schedule.cron ?? null,
          timezone: schedule.timezone ?? null,
        }
      : null,
    backfillSchedule: backfillSchedule
      ? {
          enabled: backfillSchedule.enabled === true,
          cron: backfillSchedule.cron ?? null,
          timezone: backfillSchedule.timezone ?? null,
          entities: Array.isArray(backfillSchedule.entities)
            ? backfillSchedule.entities
            : [],
          lastRunAt: backfillSchedule.lastRunAt ?? null,
        }
      : null,
    ...(invalid
      ? {
          definitionInvalid: {
            reason: invalid.reason ?? null,
            at: invalid.at ?? null,
          },
        }
      : {}),
  };
}

interface EntityStateRow {
  entity: string;
  mode?: string;
  runId?: string;
  backfillStartedAt?: Date;
  backfillCompletedAt?: Date;
  backfillCursor?: Record<string, unknown>;
  lastMaterializedAt?: Date;
  lifetimeEventsProcessed?: number;
  lifetimeRowsApplied?: number;
  destinationRowCount?: number;
  consecutiveFailures?: number;
  lastFailedAt?: Date;
  lastFailureError?: string;
  repartition?: { status?: string; error?: string };
}

function entityBackfillStatus(state: EntityStateRow | undefined): string {
  if (!state) return "not_started";
  if (
    state.backfillCompletedAt ||
    (state.backfillCursor as { hasMore?: unknown } | undefined)?.hasMore ===
      false
  ) {
    return "completed";
  }
  if (state.mode === "backfill") return "running";
  return state.backfillStartedAt ? "incomplete" : "not_started";
}

/** The whole state of one flow — what the CDC Pipeline page shows. */
async function inspectFlow(workspaceId: string, live: LiveFlow) {
  const plain = liveFlowToPlain(live, workspaceId);
  const definition = describeDefinition(plain, live);
  const row = live.row;
  if (!row) {
    return {
      ...definition,
      indexed: false,
      note: "This flow exists only in git so far: the push has not been synced, so it has no run state yet.",
    };
  }

  const [states, running, credentials] = await Promise.all([
    CdcEntityState.find({
      workspaceId: new Types.ObjectId(workspaceId),
      flowId: row._id,
    })
      .sort({ entity: 1 })
      .lean() as unknown as Promise<EntityStateRow[]>,
    FlowExecution.findOne({
      workspaceId: new Types.ObjectId(workspaceId),
      flowId: row._id,
      status: "running",
    })
      .sort({ startedAt: -1 })
      .select({ _id: 1, startedAt: 1, lastHeartbeat: 1 })
      .lean(),
    flowCredentialValues(workspaceId, row),
  ]);
  const scrub = makeRunTextScrubber(credentials);

  const stateByEntity = new Map(states.map(state => [state.entity, state]));
  const configured = resolveConfiguredEntities(row as never).entities;
  const entityNames = Array.from(
    new Set([...configured, ...states.map(state => state.entity)]),
  ).filter(Boolean);

  const meta = row.syncStateMeta;
  const result = {
    ...definition,
    indexed: true,
    streamState: row.streamState ?? "idle",
    backfill: {
      status: row.backfillState?.status ?? "idle",
      runId: row.backfillState?.runId ?? null,
      startedAt: row.backfillState?.startedAt ?? null,
      completedAt: row.backfillState?.completedAt ?? null,
      consecutiveFailures: row.backfillState?.consecutiveFailures ?? 0,
      scope: row.backfillState?.scope ?? null,
    },
    runningExecution: running
      ? {
          id: String(running._id),
          startedAt: running.startedAt ?? null,
          lastHeartbeat: running.lastHeartbeat ?? null,
        }
      : null,
    lastRunAt: row.lastRunAt ?? null,
    lastSuccessAt: row.lastSuccessAt ?? null,
    lastError: scrub(row.lastError),
    syncError:
      meta?.lastErrorMessage || meta?.lastErrorCode
        ? {
            message: scrub(meta.lastErrorMessage),
            code: meta.lastErrorCode ?? null,
            reason: scrub(meta.lastReason),
            event: meta.lastEvent ?? null,
          }
        : null,
    webhook: row.webhookConfig
      ? {
          // Never the secret; the endpoint is on the flow's page.
          enabled: row.webhookConfig.enabled === true,
          lastReceivedAt: row.webhookConfig.lastReceivedAt ?? null,
          totalReceived: row.webhookConfig.totalReceived ?? 0,
        }
      : null,
    entities: entityNames.map(entity => {
      const state = stateByEntity.get(entity);
      return {
        entity,
        configured: configured.includes(entity),
        mode: state?.mode ?? null,
        backfill: entityBackfillStatus(state),
        backfillStartedAt: state?.backfillStartedAt ?? null,
        backfillCompletedAt: state?.backfillCompletedAt ?? null,
        lastMaterializedAt: state?.lastMaterializedAt ?? null,
        rowsWritten: state?.lifetimeRowsApplied ?? 0,
        eventsProcessed: state?.lifetimeEventsProcessed ?? 0,
        destinationRows: state?.destinationRowCount ?? null,
        consecutiveFailures: state?.consecutiveFailures ?? 0,
        lastFailedAt: state?.lastFailedAt ?? null,
        lastFailureError: scrub(state?.lastFailureError),
        ...(state?.repartition?.status
          ? {
              repartition: {
                status: state.repartition.status,
                error: scrub(state.repartition.error),
              },
            }
          : {}),
      };
    }),
    next: "list_flow_runs for recent executions and their errors; flow_backfill / flow_stream (sources:write) to start or pause.",
  };
  return result;
}

interface ExecutionRow {
  _id: Types.ObjectId;
  startedAt?: Date;
  completedAt?: Date;
  lastHeartbeat?: Date;
  status?: string;
  success?: boolean;
  duration?: number;
  error?: { message?: string; code?: string | number | null } | null;
  context?: { syncMode?: string; entityFilter?: string[] } | null;
  stats?: {
    recordsProcessed?: number;
    recordsFailed?: number;
    syncedEntities?: string[];
    entityStats?: Record<string, number>;
    entityStatus?: Record<string, string>;
    currentEntity?: string;
  } | null;
  logs?: Array<{ level?: string; message?: string; timestamp?: Date }>;
}

function describeExecution(run: ExecutionRow, scrub: RunTextScrubber) {
  const logs = Array.isArray(run.logs) ? run.logs : [];
  const lastErrorLog = [...logs]
    .reverse()
    .find(line => line?.level === "error");
  return {
    id: String(run._id),
    status: run.status ?? null,
    success: run.success === true,
    startedAt: run.startedAt ?? null,
    completedAt: run.completedAt ?? null,
    lastHeartbeat: run.lastHeartbeat ?? null,
    durationMs: run.duration ?? null,
    // Message + code only: the stack is server internals, not a diagnosis.
    error: run.error
      ? { message: scrub(run.error.message), code: run.error.code ?? null }
      : null,
    lastErrorLog: lastErrorLog
      ? {
          at: lastErrorLog.timestamp ?? null,
          message: scrub(lastErrorLog.message),
        }
      : null,
    syncMode: run.context?.syncMode ?? null,
    entities: run.context?.entityFilter ?? [],
    stats: run.stats
      ? {
          recordsProcessed: run.stats.recordsProcessed ?? null,
          recordsFailed: run.stats.recordsFailed ?? null,
          syncedEntities: run.stats.syncedEntities ?? [],
          perEntity: run.stats.entityStats ?? {},
          entityStatus: run.stats.entityStatus ?? {},
          currentEntity: run.stats.currentEntity ?? null,
        }
      : null,
    logLines: logs.length,
  };
}

const BACKFILL_ACTIONS = ["start", "pause", "resume", "cancel"] as const;
type BackfillAction = (typeof BACKFILL_ACTIONS)[number];
const STREAM_ACTIONS = ["start", "pause"] as const;
type StreamAction = (typeof STREAM_ACTIONS)[number];

/**
 * Resolve a flow for a write: it must be live at main AND indexed (the same
 * rule `resolveLiveFlowRow` applies to the run button), and CDC — the only
 * engine whose backfill and stream these buttons drive.
 */
async function resolveWritableCdcFlow(
  workspaceId: string,
  ref: string,
): Promise<
  | { ok: true; flowId: string; slug: string; row: IFlow }
  | { ok: false; error: string }
> {
  const resolved = await resolveFlowRef(workspaceId, ref);
  if (!resolved.ok) return resolved;
  const { def, row } = resolved.live;
  if (!row) {
    // Same refusal `resolveLiveFlowRow` gives the run button.
    return {
      ok: false,
      error: `Flow "${def.slug}" exists only in git so far (${def.path}); it becomes runnable and editable once the push is synced.`,
    };
  }
  if (row.syncEngine !== "cdc") {
    return {
      ok: false,
      error: `Flow "${def.slug}" uses sync.engine: ${row.syncEngine ?? "legacy"}. Backfill and stream controls drive CDC flows only (sync.engine: cdc).`,
    };
  }
  return { ok: true, flowId: row._id.toString(), slug: def.slug, row };
}

/**
 * A control's failure, as the caller sees it: the service's refusals ("a
 * backfill is already running", an invalid transition) are meant to be read,
 * but they can carry a vendor or driver message, so they are scrubbed and
 * clipped like any other run-derived text — and logged, since nothing else
 * records that the call was made and failed.
 */
async function controlFailure(
  tool: "flow_backfill" | "flow_stream",
  context: {
    workspaceId: string;
    flowRef: string;
    action: string;
    userId?: string;
    target?: { flowId: string; row: IFlow };
  },
  error: unknown,
): Promise<{ error: string }> {
  const credentials = context.target
    ? await flowCredentialValues(context.workspaceId, context.target.row)
    : [];
  const message =
    makeRunTextScrubber(credentials)(
      error instanceof Error ? error.message : String(error),
    ) ?? "Unknown error";
  logger.warn(`${tool} failed`, {
    workspaceId: context.workspaceId,
    flowId: context.target?.flowId ?? context.flowRef,
    action: context.action,
    userId: context.userId,
    error: message,
  });
  return { error: message };
}

export function createFlowRunTools(workspaceId: string, userId?: string) {
  return {
    list_flows: tool({
      description: [
        "List the workspace's FLOWS (EL syncs defined by flows/<slug>.yml at main): id, slug, file path, name, source and destination connection ids, sync engine, stream state and backfill status.",
        "Use inspect_flow for one flow's full state (per-entity progress, last error) and list_flow_runs for its executions. Needs query access.",
      ].join("\n"),
      inputSchema: z.object({}),
      execute: async () => {
        try {
          const live = await loadLiveFlows(workspaceId);
          const plains = live.map(item => ({
            item,
            plain: liveFlowToPlain(item, workspaceId),
          }));
          const sourceIds = Array.from(
            new Set(
              plains
                .map(({ plain }) => idOf(plain.dataSourceId))
                .filter(
                  (id): id is string => !!id && Types.ObjectId.isValid(id),
                ),
            ),
          );
          const sources = sourceIds.length
            ? ((await SourceConnection.find({
                _id: { $in: sourceIds.map(id => new Types.ObjectId(id)) },
                workspaceId: new Types.ObjectId(workspaceId),
              })
                .select("_id name type")
                .lean()) as Array<{
                _id: Types.ObjectId;
                name?: string;
                type?: string;
              }>)
            : [];
          const sourceById = new Map(
            sources.map(source => [String(source._id), source]),
          );
          return {
            flows: plains.map(({ item, plain }) => {
              const definition = describeDefinition(plain, item);
              const source = definition.source.connectionId
                ? sourceById.get(definition.source.connectionId)
                : undefined;
              return {
                id: definition.id,
                slug: definition.slug,
                path: definition.path,
                name: definition.name,
                type: definition.type,
                syncEngine: definition.syncEngine,
                source: {
                  ...definition.source,
                  ...(source
                    ? {
                        name: source.name ?? null,
                        connector: source.type ?? null,
                      }
                    : {}),
                },
                destination: definition.destination,
                indexed: item.row != null,
                streamState: item.row?.streamState ?? null,
                backfillStatus: item.row?.backfillState?.status ?? null,
                lastRunAt: item.row?.lastRunAt ?? null,
                lastSuccessAt: item.row?.lastSuccessAt ?? null,
                ...(definition.definitionInvalid
                  ? { definitionInvalid: definition.definitionInvalid }
                  : {}),
              };
            }),
          };
        } catch (error) {
          const message =
            error instanceof Error ? error.message : "Unknown error";
          logger.error("list_flows failed", { workspaceId, error: message });
          return { error: `Failed to list flows: ${message}` };
        }
      },
    }),

    inspect_flow: tool({
      description: [
        "One FLOW's full run state — what its CDC Pipeline page shows: definition (source/destination connection ids, schedule, backfill_schedule), stream state, backfill (status, runId, startedAt, completedAt, consecutive failures), the running execution if any, lastError / lastSuccessAt, and per entity: backfill status, rows written, destination rows, events processed, last failure.",
        "Address the flow by id or by file slug. Read-only; needs query access. Run-derived messages are scrubbed of the flow's connection credentials.",
      ].join("\n"),
      inputSchema: z.object({ flowId: flowRefInput }),
      execute: async ({ flowId }: { flowId: string }) => {
        try {
          const resolved = await resolveFlowRef(workspaceId, flowId);
          if (!resolved.ok) return { error: resolved.error };
          return await inspectFlow(workspaceId, resolved.live);
        } catch (error) {
          const message =
            error instanceof Error ? error.message : "Unknown error";
          logger.error("inspect_flow failed", { workspaceId, error: message });
          return { error: `Failed to inspect flow: ${message}` };
        }
      },
    }),

    list_flow_runs: tool({
      description: [
        "Recent EXECUTIONS of one flow, newest first — the flow's Run History: status (running / completed / failed / cancelled / abandoned), started / finished, duration, the error message and code (e.g. WORKER_TIMEOUT), the last error log line, and per-entity record counts.",
        `Address the flow by id or by file slug. \`limit\` defaults to ${DEFAULT_RUN_LIMIT} (max ${MAX_RUN_LIMIT}). Read-only; needs query access. Messages are scrubbed of the flow's connection credentials.`,
      ].join("\n"),
      inputSchema: z.object({
        flowId: flowRefInput,
        limit: z
          .number()
          .int()
          .min(1)
          .max(MAX_RUN_LIMIT)
          .optional()
          .describe(`Executions to return (default ${DEFAULT_RUN_LIMIT}).`),
      }),
      execute: async ({
        flowId,
        limit,
      }: {
        flowId: string;
        limit?: number;
      }) => {
        try {
          const resolved = await resolveFlowRef(workspaceId, flowId);
          if (!resolved.ok) return { error: resolved.error };
          const row = resolved.live.row;
          if (!row) {
            return {
              flowId: resolved.live.id.toString(),
              slug: resolved.live.def.slug,
              total: 0,
              runs: [],
              note: "This flow exists only in git so far; it has not run.",
            };
          }
          const filter = {
            flowId: row._id,
            workspaceId: new Types.ObjectId(workspaceId),
          };
          const [runs, total, credentials] = await Promise.all([
            FlowExecution.find(filter)
              .sort({ startedAt: -1 })
              .limit(limit ?? DEFAULT_RUN_LIMIT)
              .select({
                startedAt: 1,
                completedAt: 1,
                lastHeartbeat: 1,
                status: 1,
                success: 1,
                duration: 1,
                "error.message": 1,
                "error.code": 1,
                "context.syncMode": 1,
                "context.entityFilter": 1,
                stats: 1,
                logs: 1,
              })
              .lean() as unknown as Promise<ExecutionRow[]>,
            FlowExecution.countDocuments(filter),
            flowCredentialValues(workspaceId, row),
          ]);
          const scrub = makeRunTextScrubber(credentials);
          return {
            flowId: row._id.toString(),
            slug: resolved.live.def.slug,
            total,
            runs: runs.map(run => describeExecution(run, scrub)),
          };
        } catch (error) {
          const message =
            error instanceof Error ? error.message : "Unknown error";
          logger.error("list_flow_runs failed", {
            workspaceId,
            error: message,
          });
          return { error: `Failed to list flow runs: ${message}` };
        }
      },
    }),

    flow_backfill: tool({
      description: [
        "Drive a CDC flow's BACKFILL, exactly like the Start / Pause / Resume / Cancel buttons on its CDC Pipeline page:",
        "- start: begin a backfill (optionally only `entities`); resumes an existing run id when one is pending.",
        "- pause: stop between steps, keeping the run's checkpoints, so resume continues it.",
        "- resume: continue a paused backfill and drain pending events.",
        "- cancel: stop and drop the run, so the next start is a new run rather than a resume.",
        "Follow it with inspect_flow / list_flow_runs. Requires the 'sources:write' scope AND that the credential's user is an owner or admin of the workspace.",
      ].join("\n"),
      inputSchema: z.object({
        flowId: flowRefInput,
        action: z.enum(BACKFILL_ACTIONS),
        entities: z
          .array(z.string())
          .optional()
          .describe(
            "start only: backfill just these entities (default: every configured entity).",
          ),
      }),
      execute: async ({
        flowId,
        action,
        entities,
      }: {
        flowId: string;
        action: BackfillAction;
        entities?: string[];
      }) => {
        const auth = await authorizeSourceWriter(workspaceId, userId);
        if (!auth.ok) return { error: auth.reason };
        if (entities?.length && action !== "start") {
          return { error: "`entities` applies to action: start only." };
        }
        let target: Awaited<ReturnType<typeof resolveWritableCdcFlow>> | null =
          null;
        try {
          target = await resolveWritableCdcFlow(workspaceId, flowId);
          if (!target.ok) return { error: target.error };
          let result: Record<string, unknown>;
          switch (action) {
            case "start": {
              const started = await cdcBackfillService.startBackfill(
                workspaceId,
                target.flowId,
                { entities },
              );
              result = { runId: started.runId, resumed: started.reusedRunId };
              break;
            }
            case "pause":
              result = await cdcBackfillService.pauseBackfill(
                workspaceId,
                target.flowId,
              );
              break;
            case "resume":
              result = await cdcBackfillService.resumeBackfill(
                workspaceId,
                target.flowId,
              );
              break;
            case "cancel":
              result = await cdcBackfillService.cancelBackfill(
                workspaceId,
                target.flowId,
              );
              break;
          }
          logger.info("Flow backfill driven over MCP", {
            workspaceId,
            flowId: target.flowId,
            action,
            userId,
          });
          return {
            flowId: target.flowId,
            slug: target.slug,
            action,
            ...result,
            next: "inspect_flow shows the backfill status and per-entity progress; list_flow_runs shows the execution.",
          };
        } catch (error) {
          return controlFailure(
            "flow_backfill",
            {
              workspaceId,
              flowRef: flowId,
              action,
              userId,
              target: target?.ok ? target : undefined,
            },
            error,
          );
        }
      },
    }),

    flow_stream: tool({
      description: [
        "Start or pause a CDC flow's live STREAM (applying change events to the destination), exactly like the stream buttons on its CDC Pipeline page. Pausing the stream does not pause a running backfill — use flow_backfill for that.",
        "Requires the 'sources:write' scope AND that the credential's user is an owner or admin of the workspace.",
      ].join("\n"),
      inputSchema: z.object({
        flowId: flowRefInput,
        action: z.enum(STREAM_ACTIONS),
      }),
      execute: async ({
        flowId,
        action,
      }: {
        flowId: string;
        action: StreamAction;
      }) => {
        const auth = await authorizeSourceWriter(workspaceId, userId);
        if (!auth.ok) return { error: auth.reason };
        let target: Awaited<ReturnType<typeof resolveWritableCdcFlow>> | null =
          null;
        try {
          target = await resolveWritableCdcFlow(workspaceId, flowId);
          if (!target.ok) return { error: target.error };
          const result =
            action === "start"
              ? await cdcBackfillService.resumeStream(
                  workspaceId,
                  target.flowId,
                )
              : await cdcBackfillService.pauseStream(
                  workspaceId,
                  target.flowId,
                );
          logger.info("Flow stream driven over MCP", {
            workspaceId,
            flowId: target.flowId,
            action,
            userId,
          });
          return {
            flowId: target.flowId,
            slug: target.slug,
            action,
            ...(result as Record<string, unknown>),
          };
        } catch (error) {
          return controlFailure(
            "flow_stream",
            {
              workspaceId,
              flowRef: flowId,
              action,
              userId,
              target: target?.ok ? target : undefined,
            },
            error,
          );
        }
      },
    }),
  };
}
