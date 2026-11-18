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
 * cancel is `cancelFlowRuns` (POST …/cancel); a
 * trigger change sets the fields exactly as PUT /flows/:id (poll, webhook)
 * and POST …/backfill-schedule (resync) do, commits `flows/<slug>.yml`
 * (`commitFlowFile`, which lands it on the mirror's main or fails), then
 * saves. Same role rule too: owner or admin. A trigger change runs one at a
 * time per workspace, re-reads the row from main first and commits only if
 * the file at main is still the one the row came from (else it retries).
 */
import { tool, type ToolSet } from "ai";
import { Types } from "mongoose";
import { z } from "zod";

import { RepoRequiredError, appsRequireConnectedRepo } from "../../apps/config";
import {
  freshenBeforeMainWrite,
  freshenForServe,
  keyedSerial,
  resolveMirrorTarget,
} from "../../apps/cloud-repo.service";
import { requireWorkspaceRepo } from "../../apps/workspace-repo-required";
import {
  CdcEntityState,
  Flow,
  FlowExecution,
  type IFlow,
} from "../../database/workspace-schema";
import { flowToFile } from "../../services/flow-config-files";
import {
  commitFlowFile,
  flowDefinitionDrift,
} from "../../services/flow-config.service";
import { ensureFlowDerivedCache } from "../../services/flow-sync.service";
import {
  deriveTriggerSet,
  hasWebhookTrigger,
  isWebhookFlow,
} from "../../services/flow-triggers.service";
import {
  RELEASE_PROVISION_CLAIM,
  claimWebhookProvision,
  persistProvisionedWebhook,
  provisionFlowWebhook,
  releaseWebhookProvision,
} from "../../services/flow-webhook-provision.service";
import { syncFlowWebhookSubscription } from "../../services/flow-webhook-subscription.service";
import { generateWebhookEndpoint } from "../../utils/webhook.utils";
import { workspaceService } from "../../services/workspace.service";
import { cdcBackfillService } from "../../sync-cdc/backfill";
import { resyncLastRunAt } from "../../services/resync-schedule";
import { cancelFlowRuns } from "../../services/flow-cancel.service";
import {
  DATA_DIFF_MIN_LOST,
  DATA_DIFF_MIN_RATIO,
  listFlowDataDiffs,
} from "../../sync-cdc/data-diff";

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

type DataDiffRow = Awaited<ReturnType<typeof listFlowDataDiffs>>[number];

/** One data-diff check as flow_status and flow_data_diff show it. */
export function summarizeDataDiff(check: DataDiffRow, flagLimit?: number) {
  const flagged = check.flagged ?? [];
  return {
    status: check.status,
    reasons: check.reasons,
    baselineAt: check.baselineAt,
    comparedAt: check.comparedAt ?? null,
    executionId: check.executionId ?? null,
    ...(check.from ? { baselineFrom: check.from } : {}),
    tables: (check.tables ?? []).map(t => ({
      entity: t.entity,
      table: t.table,
      rowsBefore: t.before?.rows ?? null,
      rowsAfter: t.after?.rows ?? null,
      ...(t.error ? { error: t.error } : {}),
    })),
    flaggedCount: flagged.length,
    flagged: flagLimit === undefined ? flagged : flagged.slice(0, flagLimit),
  };
}

/** The same precondition every flow write route checks first. */
async function assertFlowRepo(workspaceId: string): Promise<void> {
  await requireWorkspaceRepo(workspaceId);
  if (appsRequireConnectedRepo() && !(await resolveMirrorTarget(workspaceId))) {
    throw new RepoRequiredError();
  }
}

/** Attempts of one flow_update when main moves under it (a conflict). */
export const FLOW_WRITE_ATTEMPTS = 3;

/** One flow definition write per workspace at a time on this instance. */
const flowWrites = keyedSerial();

/**
 * flow_update's change, set on the row in memory exactly as PUT /flows/:id
 * (poll, webhook) and POST …/backfill-schedule (resync) do. Returns a
 * refusal, or null.
 */
function applyTriggerChange(
  workspaceId: string,
  flow: IFlow,
  change: {
    poll?: string;
    webhook?: "on" | "off";
    resync?: string;
    tz?: string;
  },
): string | null {
  const { poll, webhook, resync, tz } = change;
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
  // PUT /flows/:id: switching webhooks on gives any flow its inbound URL
  // (same formula, minted once); polling is untouched.
  if (webhook !== undefined) {
    if (webhook === "on" && !flow.webhookConfig?.endpoint) {
      flow.webhookConfig = {
        ...((flow.webhookConfig as unknown as Record<string, unknown>) ?? {}),
        endpoint: generateWebhookEndpoint(workspaceId, flow._id.toString()),
        enabled: true,
      } as typeof flow.webhookConfig;
    } else if (flow.webhookConfig) {
      flow.webhookConfig.enabled = webhook === "on";
    }
  }
  // POST …/backfill-schedule
  if (resync !== undefined) {
    if (flow.syncEngine !== "cdc") {
      return "Scheduled resync requires syncEngine=cdc";
    }
    const on = resync !== "off";
    const next = {
      enabled: on,
      cron: on ? resync.trim() : flow.backfillSchedule?.cron,
      timezone: tz || flow.backfillSchedule?.timezone || "UTC",
    };
    flow.backfillSchedule = {
      ...next,
      entities: flow.backfillSchedule?.entities,
      // A new or changed resync first runs at its next tick.
      lastRunAt: resyncLastRunAt(flow.backfillSchedule, next),
    };
  }
  return null;
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
          // Names come only from this workspace's connections: an id of
          // another workspace's populates as null (flow-connection-scope.ts).
          const inThisWorkspace = {
            workspaceId: new Types.ObjectId(workspaceId),
          };
          const flows = await Flow.find(inThisWorkspace)
            .populate({
              path: "dataSourceId",
              select: "name type",
              match: inThisWorkspace,
            })
            .populate({
              path: "destinationDatabaseId",
              select: "name type",
              match: inThisWorkspace,
            })
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
        "How a sync is doing, per entity: mode (steady / backfill), backlog, consecutive failures and the last error, last materialised, last backfill, lifetime events and rows; its last runs; its last data-diff check (columns that lost non-null values, see flow_data_diff); and definitionAtMain, whether the database row means what flows/<slug>.yml at main says, read after fetching main from the repo, at the `commit` it names (inSync false: the next push to main changes the sync). Use it after flow_backfill or flow_update, and to find a sync that went quiet.",
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
          const [lastDiff] = await listFlowDataDiffs(flow._id, 1);
          // Compare against the mirror's main, not this instance's cache:
          // another instance may have pushed the commit this row follows.
          // Best-effort (a failed fetch compares the cache); `commit` names
          // the head compared against either way.
          await freshenForServe(workspaceId, 0).catch(() => undefined);
          const definition = await flowDefinitionDrift(flow).catch(error => ({
            error: error instanceof Error ? error.message : String(error),
          }));
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
            dataDiff: lastDiff ? summarizeDataDiff(lastDiff, 10) : null,
            // Row vs flows/<slug>.yml at main: inSync false means the next
            // push to main changes this sync (see `reason`, `differs`).
            definitionAtMain: definition,
            executions: runs.map(r => ({
              id: r._id.toString(),
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

    flow_data_diff: tool({
      description: `The data-diff checks of a sync, newest first. A check records each destination column's non-null count before a write that can rewrite rows (a backfill or resync, an entity reset, a connector, connector-code or destination change) and again after the next successful run. \`flagged\` lists the columns (and "(rows)") that lost more than ${DATA_DIFF_MIN_LOST} values and ${DATA_DIFF_MIN_RATIO * 100}% of their baseline, scaled down when the table shrank. status "open" means the baseline waits for a run.`,
      inputSchema: z.object({
        flow: flowRef,
        limit: z
          .number()
          .int()
          .min(1)
          .max(20)
          .optional()
          .describe("How many checks to show (default 5)"),
      }),
      execute: async ({ flow: ref, limit }) => {
        try {
          const flow = await findFlow(workspaceId, ref);
          const checks = await listFlowDataDiffs(flow._id, limit ?? 5);
          return {
            success: true,
            id: flow._id.toString(),
            name: flow.name ?? flow.slug,
            checks: checks.map(check => summarizeDataDiff(check)),
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

    flow_cancel: tool({
      description:
        "Cancel a sync's running work: with no `executionId`, every running execution plus its CDC backfill when one is running or paused; with `executionId`, that run only, and a live backfill keeps its state and resume point. Returns what it cancelled. Owner or admin. Follow it with flow_status.",
      inputSchema: z.object({
        flow: flowRef,
        executionId: z
          .string()
          .optional()
          .describe(
            "Cancel only this run (flow_status lists run ids; default: every running one and the backfill)",
          ),
      }),
      execute: async ({ flow: ref, executionId }) => {
        try {
          if (!(await mayChange())) {
            return failure("Owner/admin role required");
          }
          const flow = await findFlow(workspaceId, ref);
          const result = await cancelFlowRuns(workspaceId, flow, executionId, {
            cancelBackfill: true,
          });
          return {
            success: true,
            id: result.flowId,
            cancelled: result.executions,
            backfill: result.backfill,
          };
        } catch (error) {
          return failure(error);
        }
      },
    }),

    flow_webhook_provision: tool({
      description:
        "Create the provider-side webhook subscription of a sync, as the Triggers step's \"Create in …\" button does: the subscription points at this deployment's webhook URL (server configuration, never a stored or requested host), its signing secret is stored on the sync and never returned, flows/<slug>.yml is committed. Idempotent: a sync that already has a subscription creates nothing; where the connector can update one (Stripe, Wise), its event list is set again to what the sync's entities need (status: updated), so a new Mako event list reaches an existing endpoint, keeping its signing secret; otherwise it is reported (status: existing). A subscription already on the URL is adopted where the connector can find it. The webhook trigger must be on (flow_update webhook=on). Owner or admin.",
      inputSchema: z.object({ flow: flowRef }),
      execute: async ({ flow: ref }) => {
        try {
          if (!(await mayChange())) {
            return failure("Owner/admin role required");
          }
          await assertFlowRepo(workspaceId);
          const found = await findFlow(workspaceId, ref);
          if (!hasWebhookTrigger(found)) {
            return failure(
              "The sync's webhook trigger is off. Turn it on with flow_update (webhook: on) first.",
            );
          }
          const existing = (f: IFlow) => ({
            success: true as const,
            id: f._id.toString(),
            status: "existing" as const,
            endpoint: f.webhookConfig?.endpoint ?? null,
            providerWebhookId: f.webhookConfig?.providerWebhookId ?? null,
          });
          const flow = await claimWebhookProvision({
            flowId: found._id,
            workspaceId,
            unprovisionedOnly: true,
          });
          if (!flow) {
            const current = await Flow.findById(found._id);
            if (
              current?.webhookConfig?.providerWebhookId ||
              current?.webhookConfig?.secret
            ) {
              // Already provisioned. With its secret on record, set the
              // provider's event list again from the sync's entities: a new
              // Mako event list (or entity) reaches an existing endpoint.
              // An update in place, idempotent, never a create; the signing
              // secret stays. Without a secret, report it untouched.
              if (!current.webhookConfig?.secret) return existing(current);
              const sync = await syncFlowWebhookSubscription(current, {
                mayProvision: false,
              });
              if (sync.status === "updated") {
                return {
                  success: true as const,
                  id: current._id.toString(),
                  status: "updated" as const,
                  endpoint: current.webhookConfig?.endpoint ?? null,
                  providerWebhookId: sync.providerWebhookId,
                };
              }
              if (sync.status === "failed") {
                return failure(
                  `The sync's webhook subscription could not be updated: ${sync.error}`,
                );
              }
              if (sync.status === "not_found") {
                return failure(
                  "The sync holds a signing secret, but no provider webhook subscription points at its URL. Re-create it from the Triggers step.",
                );
              }
              return existing(current);
            }
            return failure(
              "Another provisioning of this sync is in progress; check flow_read in a minute.",
            );
          }
          let provisioned;
          try {
            provisioned = await provisionFlowWebhook({
              workspaceId,
              flow,
              body: { adopt: true },
            });
          } catch (error) {
            await releaseWebhookProvision(flow._id);
            throw error;
          }
          const { endpoint, created, webhookConfig, connectorType } =
            provisioned;
          // The row first: the subscription exists at the provider now.
          await persistProvisionedWebhook(flow, RELEASE_PROVISION_CLAIM);
          // persistProvisionedWebhook released the claim in the database.
          // Leave the in-memory path untouched, or flow.save() below would
          // write null over a claim another request took since.
          const committed = await commitFlowFile(flow, userId);
          if (!committed.ok) {
            return failure(
              `The subscription ${created.providerWebhookId} is saved on the sync, but flows/<slug>.yml could not be committed: ${committed.error ?? "unknown error"}. Saving the flow again commits it.`,
            );
          }
          if (committed.sourceBlobSha) {
            flow.sourceBlobSha = committed.sourceBlobSha;
          }
          await flow.save();
          if (!webhookConfig.secret) {
            return failure(
              `The ${connectorType} webhook subscription ${created.providerWebhookId} exists, but the provider did not return a signing secret (an adopted endpoint never shows it again). Paste it into the sync's Webhook Secret field.`,
            );
          }
          return {
            success: true,
            id: flow._id.toString(),
            status: "created" as const,
            vendor: connectorType,
            endpoint,
            providerWebhookId: created.providerWebhookId,
          };
        } catch (error) {
          return failure(error);
        }
      },
    }),

    flow_update: tool({
      description:
        'Change what starts a sync — only the three trigger controls: `poll` (a cron, or "off"), `webhook` ("on" / "off"; on gives the sync its webhook URL and installs or adopts the provider subscription where the connector can; polling keeps running), `resync` (a cron for the periodic full re-read, or "off"). Commits flows/<slug>.yml to main and pushes it to the workspace repo before saving: a write that does not land saves nothing and returns the cause. The result carries `commit`, the sha at main holding the definition. Owner or admin.',
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
          const tz = timezone?.trim() || undefined;
          // One flow write per workspace at a time on this instance; across
          // instances the conditional commit below is the arbiter.
          const outcome = await flowWrites(workspaceId, async () => {
            for (let attempt = 1; ; attempt++) {
              // The row first follows main: a row ahead of main (its commit
              // never landed) or behind it (a merge not yet reconciled) must
              // not be what this write's whole file is built from.
              await freshenBeforeMainWrite(workspaceId);
              let flow = await findFlow(workspaceId, ref);
              const synced = await ensureFlowDerivedCache(flow);
              if (synced === "invalid" || synced === "missing") {
                // The row no longer follows a valid file at main (and was
                // just switched off). Writing the row's last good definition
                // would overwrite or recreate that file blind.
                const fresh = await Flow.findById(flow._id).lean();
                const why =
                  fresh?.definitionInvalid?.reason ??
                  (synced === "missing"
                    ? "the file is missing at main"
                    : "the file at main is invalid");
                return {
                  refused: `flows/${flow.slug}.yml at main is not a valid definition of this sync (${why}), so nothing was changed. Fix or restore the file on main first; the sync is off until then.`,
                } as const;
              }
              if (synced === "resynced") {
                flow = (await Flow.findById(flow._id)) ?? flow;
              }
              const base = flow.sourceBlobSha || undefined;
              const webhookOnBefore = hasWebhookTrigger(flow);
              const applied = applyTriggerChange(workspaceId, flow, {
                poll,
                webhook,
                resync,
                tz,
              });
              if (applied) return { refused: applied } as const;
              const committed = await commitFlowFile(flow, userId, undefined, {
                expectBlobAtMain: base,
              });
              if (!committed.ok) {
                if (committed.conflict && attempt < FLOW_WRITE_ATTEMPTS) {
                  continue;
                }
                return {
                  refused: `The flow definition could not be written to the workspace repo, so nothing was saved: ${committed.error ?? "unknown error"}`,
                } as const;
              }
              if (committed.sourceBlobSha) {
                flow.sourceBlobSha = committed.sourceBlobSha;
              }
              try {
                await Flow.updateOne(
                  { _id: flow._id },
                  { $unset: { definitionInvalid: 1 } },
                );
                await flow.save();
              } catch (error) {
                // The file is on main; the row follows it now rather than at
                // the next push.
                const fresh = await Flow.findById(flow._id);
                if (fresh) {
                  await ensureFlowDerivedCache(fresh).catch(() => undefined);
                }
                const message =
                  error instanceof Error ? error.message : String(error);
                return {
                  refused: `flows/${flow.slug}.yml was committed (${committed.commitSha}), but saving the sync failed: ${message}. The sync was re-read from the file; check flow_status.`,
                } as const;
              }
              return { flow, committed, webhookOnBefore } as const;
            }
          });
          if ("refused" in outcome) return failure(outcome.refused);
          const { flow, committed, webhookOnBefore } = outcome;

          // As PUT: webhooks newly on need a provider subscription (adopted by
          // URL, created only when none exists). Best-effort: polling carries on.
          let warning: string | undefined;
          if (
            isWebhookFlow(flow) &&
            (!webhookOnBefore ||
              // Switched off by this call: pause the provider subscription.
              !hasWebhookTrigger(flow) ||
              !flow.webhookConfig?.secret)
          ) {
            // flow_update is owner/admin only (mayChange above).
            const sync = await syncFlowWebhookSubscription(flow, {
              mayProvision: true,
            });
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
            // The commit at main that holds this definition (on the mirror
            // when one is bound): the one written, or main's head when the
            // file already said this.
            commit: committed.commitSha ?? null,
            fileChanged: committed.changed,
            ...(warning ? { warning } : {}),
          };
        } catch (error) {
          return failure(error);
        }
      },
    }),
  };
}
