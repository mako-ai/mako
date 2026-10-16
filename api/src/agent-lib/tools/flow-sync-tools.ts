/**
 * Sync (flow) agent tools: read a workspace's syncs, see how each entity is
 * doing, start a backfill, and change the three trigger controls — without a
 * browser.
 *
 * Reads go through the same rows the Flows screen shows (`flows`,
 * `cdc_entity_state`, `flow_executions`), the definition through `flowToFile`
 * (the `flows/<slug>.yml` shape, which by construction carries no secret) and
 * the triggers through `deriveTriggerSet`, so the output survives the
 * removal of `type`.
 *
 * Writes are the routes' own steps, in their order: the backfill is
 * `cdcBackfillService.startBackfill` (POST …/sync-cdc/backfill/start); a
 * trigger change sets the fields exactly as PUT /flows/:id (poll, webhook)
 * and POST …/backfill-schedule (resync) do, commits `flows/<slug>.yml`
 * (`commitFlowFile`), then saves. Same role rule too: owner or admin.
 */
import { tool, type ToolSet } from "ai";
import { Types } from "mongoose";
import { z } from "zod";

import { RepoRequiredError, appsRequireConnectedRepo } from "../../apps/config";
import { resolveMirrorTarget } from "../../apps/cloud-repo.service";
import { requireWorkspaceRepo } from "../../apps/workspace-repo-required";
import {
  CdcEntityState,
  Flow,
  FlowExecution,
  type IFlow,
} from "../../database/workspace-schema";
import { flowToFile } from "../../services/flow-config-files";
import { commitFlowFile } from "../../services/flow-config.service";
import {
  deriveTriggerSet,
  isWebhookFlow,
} from "../../services/flow-triggers.service";
import { syncFlowWebhookSubscription } from "../../services/flow-webhook-subscription.service";
import { generateWebhookEndpoint } from "../../utils/webhook.utils";
import { workspaceService } from "../../services/workspace.service";
import { cdcBackfillService } from "../../sync-cdc/backfill";

const OBJECT_ID = /^[0-9a-f]{24}$/i;
const RECENT_EXECUTIONS = 5;

const failure = (error: unknown) => ({
  success: false as const,
  error: error instanceof Error ? error.message : String(error),
});

const flowRef = z
  .string()
  .min(1)
  .describe("The sync: its id, its name, or its slug (flows/<slug>.yml)");

/** A cron of 5 or 6 fields — the rule POST …/backfill-schedule applies. */
function isCron(value: string): boolean {
  const fields = value.trim().split(/\s+/).filter(Boolean);
  return fields.length === 5 || fields.length === 6;
}

/** What starts this sync, from the fields (never from `type`). */
export function triggersOf(flow: IFlow) {
  const set = deriveTriggerSet(flow);
  return {
    poll: set.schedule
      ? { cron: flow.schedule?.cron, timezone: flow.schedule?.timezone }
      : null,
    webhook: set.webhook,
    resync: set.reconcile
      ? {
          cron: flow.backfillSchedule?.cron,
          timezone: flow.backfillSchedule?.timezone,
        }
      : null,
  };
}

function idOf(value: unknown): string | undefined {
  if (!value) return undefined;
  if (value instanceof Types.ObjectId) return value.toString();
  if (typeof value === "object" && "_id" in (value as object)) {
    return String((value as { _id: unknown })._id);
  }
  return String(value);
}

/** One sync, the row flow_list shows. */
export function summarizeFlow(flow: IFlow) {
  const source = flow.dataSourceId as unknown as
    { _id?: unknown; name?: string; type?: string } | undefined;
  const destination = flow.destinationDatabaseId as unknown as
    { _id?: unknown; name?: string; type?: string } | undefined;
  return {
    id: flow._id.toString(),
    name: flow.name ?? flow.slug ?? flow._id.toString(),
    slug: flow.slug,
    source:
      flow.sourceType === "database"
        ? { kind: "database" }
        : {
            kind: "connector",
            connectionId: idOf(source),
            name: source?.name,
            connector: source?.type,
          },
    destination: {
      connectionId: idOf(destination),
      name: destination?.name,
      type: destination?.type,
      schema: flow.tableDestination?.schema,
    },
    entities: flow.entityFilter ?? [],
    triggers: triggersOf(flow),
    engine: flow.syncEngine,
    state: flow.syncState,
  };
}

async function findFlow(workspaceId: string, ref: string) {
  const wsId = new Types.ObjectId(workspaceId);
  if (OBJECT_ID.test(ref)) {
    const byId = await Flow.findOne({ _id: ref, workspaceId: wsId });
    if (byId) return byId;
  }
  const wanted = ref.trim().toLowerCase();
  const all = await Flow.find({ workspaceId: wsId });
  const exact = all.filter(
    f => f.slug === ref || (f.name ?? "").trim().toLowerCase() === wanted,
  );
  // A short name ("wise", "fr_close") is enough when it picks out one sync:
  // the source part of "<source> → <destination>", else a unique substring.
  const source = (f: (typeof all)[number]) =>
    (f.name ?? "").split("→")[0].trim().toLowerCase();
  const bySource = all.filter(f => source(f) === wanted);
  const byPart = all.filter(f => (f.name ?? "").toLowerCase().includes(wanted));
  const matches = exact.length ? exact : bySource.length ? bySource : byPart;
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    throw new Error(
      `${matches.length} syncs match "${ref}"; pass the id: ${matches
        .map(f => f._id.toString())
        .join(", ")}`,
    );
  }
  throw new Error(`No sync "${ref}" in this workspace. flow_list shows them.`);
}

/** The same precondition every flow write route checks first. */
async function assertFlowRepo(workspaceId: string): Promise<void> {
  await requireWorkspaceRepo(workspaceId);
  if (appsRequireConnectedRepo() && !(await resolveMirrorTarget(workspaceId))) {
    throw new RepoRequiredError();
  }
}

export function createFlowSyncTools({
  workspaceId,
  userId,
}: {
  workspaceId: string;
  userId?: string;
}): ToolSet {
  /** The flow write routes' rule (assertOwnerOrAdmin). */
  const mayChange = async () =>
    !userId ||
    workspaceService.hasRole(workspaceId, userId, ["owner", "admin"]);

  return {
    flow_list: tool({
      description:
        "List this workspace's syncs (flows): id, name, source connection and its connector, destination, entities, triggers (poll cron, webhook on/off, resync cron), engine and state.",
      inputSchema: z.object({}),
      execute: async () => {
        try {
          const flows = await Flow.find({
            workspaceId: new Types.ObjectId(workspaceId),
          })
            .populate("dataSourceId", "name type")
            .populate("destinationDatabaseId", "name type")
            .sort({ name: 1 });
          return { success: true, flows: flows.map(summarizeFlow) };
        } catch (error) {
          return failure(error);
        }
      },
    }),

    flow_read: tool({
      description:
        "One sync in full: its definition as in flows/<slug>.yml (source, destination, entities and layouts, sync settings), its triggers and state. Never carries a credential or the webhook signing secret.",
      inputSchema: z.object({ flow: flowRef }),
      execute: async ({ flow: ref }) => {
        try {
          const flow = await findFlow(workspaceId, ref);
          return {
            success: true,
            id: flow._id.toString(),
            definition: flowToFile(flow),
            triggers: triggersOf(flow),
            engine: flow.syncEngine,
            state: flow.syncState,
            definitionInvalid: flow.definitionInvalid ?? null,
          };
        } catch (error) {
          return failure(error);
        }
      },
    }),

    flow_status: tool({
      description:
        "How a sync is doing, per entity: mode (steady / backfill), backlog, consecutive failures and the last error, last materialised, last backfill, lifetime events and rows; plus its last runs. Use it after flow_backfill or flow_update, and to find a sync that went quiet.",
      inputSchema: z.object({
        flow: flowRef,
        executions: z
          .number()
          .int()
          .min(0)
          .max(50)
          .optional()
          .describe(
            `How many recent runs to show (default ${RECENT_EXECUTIONS})`,
          ),
      }),
      execute: async ({ flow: ref, executions }) => {
        try {
          const flow = await findFlow(workspaceId, ref);
          const flowIdStr = flow._id.toString();
          // Rows written by older code keep string ids: match both forms.
          const states = await CdcEntityState.find({
            workspaceId: {
              $in: [workspaceId, new Types.ObjectId(workspaceId)],
            },
            flowId: { $in: [flowIdStr, flow._id] },
          })
            .sort({ entity: 1 })
            .lean();
          const runs = await FlowExecution.find({ flowId: flow._id })
            .sort({ startedAt: -1 })
            .limit(executions ?? RECENT_EXECUTIONS)
            .select(
              "status success startedAt completedAt duration error.message",
            )
            .lean();
          return {
            success: true,
            id: flowIdStr,
            name: flow.name ?? flow.slug,
            triggers: triggersOf(flow),
            state: flow.syncState,
            entities: states.map(s => ({
              entity: s.entity,
              mode: s.mode,
              backlog: s.backlogCount,
              consecutiveFailures: s.consecutiveFailures,
              lastFailedAt: s.lastFailedAt ?? null,
              lastFailureError: s.lastFailureError ?? null,
              lastMaterializedAt: s.lastMaterializedAt ?? null,
              backfillCompletedAt: s.backfillCompletedAt ?? null,
              lifetimeEventsProcessed: s.lifetimeEventsProcessed,
              lifetimeRowsApplied: s.lifetimeRowsApplied,
            })),
            executions: runs.map(r => ({
              status: r.status,
              success: r.success,
              startedAt: r.startedAt,
              completedAt: r.completedAt ?? null,
              durationMs: r.duration ?? null,
              error: r.error?.message ?? null,
            })),
          };
        } catch (error) {
          return failure(error);
        }
      },
    }),

    flow_backfill: tool({
      description:
        "Start a full backfill of a CDC sync now: every record of its entities (or only `entities`) is read again and merged; newer rows are never overwritten by older ones. Owner or admin. Follow it with flow_status.",
      inputSchema: z.object({
        flow: flowRef,
        entities: z
          .array(z.string().min(1))
          .optional()
          .describe("Only these entities (default: all the sync's entities)"),
      }),
      execute: async ({ flow: ref, entities }) => {
        try {
          if (!(await mayChange())) {
            return failure("Owner/admin role required");
          }
          const flow = await findFlow(workspaceId, ref);
          if (flow.syncEngine !== "cdc") {
            return failure("Backfill requires syncEngine=cdc");
          }
          const run = await cdcBackfillService.startBackfill(
            workspaceId,
            flow._id.toString(),
            { entities },
          );
          return {
            success: true,
            id: flow._id.toString(),
            runId: run.runId,
            resumed: run.reusedRunId,
          };
        } catch (error) {
          return failure(error);
        }
      },
    }),

    flow_update: tool({
      description:
        'Change what starts a sync — only the three trigger controls: `poll` (a cron, or "off"), `webhook` ("on" / "off"; on gives the sync its webhook URL and installs or adopts the provider subscription where the connector can; polling keeps running), `resync` (a cron for the periodic full re-read, or "off"). Writes flows/<slug>.yml on main, then saves. Owner or admin.',
      inputSchema: z.object({
        flow: flowRef,
        poll: z.string().optional().describe('Cron for polling, or "off"'),
        webhook: z.enum(["on", "off"]).optional(),
        resync: z
          .string()
          .optional()
          .describe('Cron for the periodic full resync, or "off"'),
        timezone: z
          .string()
          .optional()
          .describe(
            "IANA timezone for the crons given (default: as before, else UTC)",
          ),
      }),
      execute: async ({ flow: ref, poll, webhook, resync, timezone }) => {
        try {
          if (
            poll === undefined &&
            webhook === undefined &&
            resync === undefined
          ) {
            return failure("Nothing to change: pass poll, webhook or resync");
          }
          if (!(await mayChange())) {
            return failure("Owner/admin role required");
          }
          for (const [name, value] of [
            ["poll", poll],
            ["resync", resync],
          ] as const) {
            if (value !== undefined && value !== "off" && !isCron(value)) {
              return failure(
                `${name}: "${value}" is not a cron (5 or 6 fields) nor "off"`,
              );
            }
          }
          await assertFlowRepo(workspaceId);
          const flow = await findFlow(workspaceId, ref);
          const tz = timezone?.trim() || undefined;

          // PUT /flows/:id
          if (poll !== undefined) {
            const on = poll !== "off";
            flow.schedule = {
              enabled: on,
              cron: on ? poll.trim() : flow.schedule?.cron,
              timezone: on
                ? tz || flow.schedule?.timezone || "UTC"
                : flow.schedule?.timezone,
            };
          }
          // PUT /flows/:id: switching webhooks on gives any flow its inbound
          // URL (same formula, minted once); polling is untouched.
          const webhookOnBefore = isWebhookFlow(flow);
          if (webhook !== undefined) {
            if (webhook === "on" && !flow.webhookConfig?.endpoint) {
              flow.webhookConfig = {
                ...((flow.webhookConfig as unknown as Record<
                  string,
                  unknown
                >) ?? {}),
                endpoint: generateWebhookEndpoint(
                  workspaceId,
                  flow._id.toString(),
                ),
                enabled: true,
              } as typeof flow.webhookConfig;
            } else if (flow.webhookConfig) {
              flow.webhookConfig.enabled = webhook === "on";
            }
          }
          // POST …/backfill-schedule
          if (resync !== undefined) {
            if (flow.syncEngine !== "cdc") {
              return failure("Scheduled resync requires syncEngine=cdc");
            }
            const on = resync !== "off";
            flow.backfillSchedule = {
              enabled: on,
              cron: on ? resync.trim() : flow.backfillSchedule?.cron,
              timezone: tz || flow.backfillSchedule?.timezone || "UTC",
              entities: flow.backfillSchedule?.entities,
              lastRunAt: flow.backfillSchedule?.lastRunAt,
            };
          }

          const committed = await commitFlowFile(flow, userId);
          if (!committed.ok) {
            return failure(
              `The flow definition could not be written to the workspace repo, so nothing was saved: ${committed.error ?? "unknown error"}`,
            );
          }
          if (committed.sourceBlobSha) {
            flow.sourceBlobSha = committed.sourceBlobSha;
          }
          await Flow.updateOne(
            { _id: flow._id },
            { $unset: { definitionInvalid: 1 } },
          );
          await flow.save();
          // As PUT: webhooks newly on need a provider subscription (adopted by
          // URL, created only when none exists). Best-effort: polling carries on.
          let warning: string | undefined;
          if (
            isWebhookFlow(flow) &&
            (!webhookOnBefore || !flow.webhookConfig?.secret)
          ) {
            const sync = await syncFlowWebhookSubscription(flow);
            if (sync.status === "failed") {
              warning = `Saved, but the provider webhook subscription could not be set up: ${sync.error}. The sync keeps polling.`;
            } else if (sync.status === "not_found") {
              warning =
                "Saved, but no provider webhook subscription points at this sync's URL; re-provision it from the Triggers step.";
            }
          }
          return {
            success: true,
            id: flow._id.toString(),
            triggers: triggersOf(flow),
            ...(warning ? { warning } : {}),
          };
        } catch (error) {
          return failure(error);
        }
      },
    }),
  };
}
