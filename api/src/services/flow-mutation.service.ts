/**
 * The create and update of a flow definition, minus the HTTP: build or patch
 * the Flow document from a request body, validating the sync config on the
 * way. Refusals are {@link FlowRequestError}s.
 *
 * Persisting is the route's job, in RFC #904 order — commit the file
 * (`commitFlowFileOrFail`), then `flow.save()` — so the repo gate and the
 * write-through stay visible at every mutating route.
 */
import { inWorkspace } from "../utils/workspace-scope";
import type { IncrementalCapabilities } from "@mako/schemas";
import { Types } from "mongoose";
import { asSystem } from "../access/connection-writes";
import {
  DatabaseConnection,
  Flow,
  SourceConnection,
  type IFlow,
} from "../database/workspace-schema";
import { databaseRegistry } from "../databases/registry";
import { loggers } from "../logging";
import { hasCdcDestinationAdapter } from "../sync-cdc/adapters/registry";
import { generateWebhookEndpoint } from "../utils/webhook.utils";
import {
  checkQuerySafety,
  createDestinationWriter,
} from "./destination-writer.service";
import {
  deriveFlowDisplayName,
  reserveFlowSlug,
} from "./flow-identity.service";
import { FlowRequestError } from "./flow-request-error";
import { listFlowDefinitionsAtMain } from "./flow-sync.service";
import {
  connectorFlowCdcError,
  hasWebhookTrigger,
  isWebhookFlow,
  resolveDefaultSyncEngine,
} from "./flow-triggers.service";
import {
  flowEntitySignature,
  PROVISION_NEEDS_ADMIN,
  syncFlowWebhookSubscription,
} from "./flow-webhook-subscription.service";
import {
  resolveConnectorIncrementalCapabilities,
  selectedEntitiesFromFlowBody,
  validateWriteMode,
} from "./flow-write-validation.service";
import { resyncLastRunAt } from "./resync-schedule";

const logger = loggers.inngest("flow");

type FlowDocument = InstanceType<typeof Flow>;

/** A create/update request body: the loose JSON the flow forms POST. */
type FlowRequestBody = Record<string, any>;

/**
 * Build the (unsaved) Flow for a create request: validate source,
 * destination, engine and sync config, mint the display name and slug, and
 * the webhook endpoint when webhooks start on.
 */
export async function buildNewFlow(params: {
  workspaceId: string;
  body: FlowRequestBody;
}) {
  const { workspaceId, body } = params;
  // TODO: Get userId from authentication
  const userId = "system";
  // Webhooks on at creation: `webhookConfig.enabled`, or the retired
  // `type: "webhook"` older clients still send. Not stored: a flow's
  // triggers are its schedule, its webhook config and its resync.
  const webhookOn =
    body.webhookConfig?.enabled === true || body.type === "webhook";
  const sourceType = body.sourceType || "connector";

  // Schedule cron required whenever a poll schedule is enabled,
  // regardless of flow type (unified trigger model).
  if (body.schedule?.enabled && !body.schedule?.cron) {
    throw new FlowRequestError(400, "schedule.cron is required when enabled");
  }

  // Validate source configuration based on sourceType
  if (sourceType === "database") {
    // Database source validation
    if (!body.databaseSource?.connectionId) {
      throw new FlowRequestError(
        400,
        "databaseSource.connectionId is required",
      );
    }
    if (!body.databaseSource?.query) {
      throw new FlowRequestError(400, "databaseSource.query is required");
    }

    // Validate query safety (read-only SELECT only)
    const safetyCheck = checkQuerySafety(body.databaseSource.query);
    if (!safetyCheck.safe) {
      throw new FlowRequestError(
        400,
        `Unsafe query: ${safetyCheck.errors.join("; ")}`,
        { safetyCheck },
      );
    }

    // Validate source database connection exists and belongs to workspace
    const sourceDb = await DatabaseConnection.findOne({
      _id: new Types.ObjectId(body.databaseSource.connectionId),
      workspaceId: new Types.ObjectId(workspaceId),
    });

    if (!sourceDb) {
      throw new FlowRequestError(404, "Source database connection not found");
    }
  } else {
    // Connector source validation (default)
    if (!body.dataSourceId) {
      throw new FlowRequestError(400, "dataSourceId is required");
    }

    // Validate data source exists and belongs to workspace
    const sourceConnection = await SourceConnection.findOne({
      _id: new Types.ObjectId(body.dataSourceId),
      workspaceId: new Types.ObjectId(workspaceId),
    });

    if (!sourceConnection) {
      throw new FlowRequestError(404, "Data source not found");
    }
  }

  // Validate destination - either destinationDatabaseId or tableDestination
  let destinationDatabaseId: Types.ObjectId | undefined;
  let destinationType: string | undefined;

  if (body.tableDestination?.connectionId) {
    // Table destination validation
    const destDb = await DatabaseConnection.findOne({
      _id: new Types.ObjectId(body.tableDestination.connectionId),
      workspaceId: new Types.ObjectId(workspaceId),
    });

    if (!destDb) {
      throw new FlowRequestError(
        404,
        "Destination database connection not found",
      );
    }

    // Use the table destination connection as the destinationDatabaseId
    destinationDatabaseId = new Types.ObjectId(
      body.tableDestination.connectionId,
    );
    destinationType = destDb.type;
  } else if (body.destinationDatabaseId) {
    // MongoDB destination validation
    const database = await DatabaseConnection.findOne({
      _id: new Types.ObjectId(body.destinationDatabaseId),
      workspaceId: new Types.ObjectId(workspaceId),
    });

    if (!database) {
      throw new FlowRequestError(404, "Destination database not found");
    }

    destinationDatabaseId = new Types.ObjectId(body.destinationDatabaseId);
    destinationType = database.type;
  } else {
    throw new FlowRequestError(
      400,
      "destinationDatabaseId or tableDestination is required",
    );
  }

  // CDC is the only engine for connector flows: refuse one it cannot run.
  const cdcError = connectorFlowCdcError({
    sourceType,
    hasTableDestination: Boolean(body.tableDestination?.connectionId),
    destinationSupportsCdc: hasCdcDestinationAdapter(destinationType),
  });
  if (cdcError) {
    throw new FlowRequestError(400, cdcError);
  }

  // Create flow with type-specific configuration
  const flowData: any = {
    workspaceId: new Types.ObjectId(workspaceId),
    sourceType,
    destinationDatabaseId,
    destinationDatabaseName:
      typeof body.destinationDatabaseName === "string" &&
      body.destinationDatabaseName.trim().length > 0
        ? body.destinationDatabaseName.trim()
        : undefined,
    syncMode: body.syncMode || "full",
    // CDC for every connector flow (the legacy engine has been removed).
    syncEngine: resolveDefaultSyncEngine({ sourceType }),
    writeMode: body.writeMode || "append_dedup",
    syncStateUpdatedAt: new Date(),
    enabled: true,
    createdBy: userId,
  };

  // Optional periodic full-backfill cadence (CDC flows only).
  if ((webhookOn || flowData.syncEngine === "cdc") && body.backfillSchedule) {
    const sched = body.backfillSchedule;
    const enabled = Boolean(sched.enabled);
    const cron = typeof sched.cron === "string" ? sched.cron.trim() : "";
    if (enabled && cron) {
      const next = {
        enabled: true,
        cron,
        timezone:
          typeof sched.timezone === "string" && sched.timezone.trim()
            ? sched.timezone.trim()
            : "UTC",
      };
      // A new resync first runs at its next tick (resync-schedule.ts).
      flowData.backfillSchedule = {
        ...next,
        lastRunAt: resyncLastRunAt(undefined, next),
      };
    }
  }

  // Add source-specific fields
  if (sourceType === "database") {
    flowData.databaseSource = {
      connectionId: new Types.ObjectId(body.databaseSource.connectionId),
      database: body.databaseSource.database,
      query: body.databaseSource.query,
    };

    // Database source specific config
    if (body.incrementalConfig) {
      flowData.incrementalConfig = body.incrementalConfig;
    }
    if (body.conflictConfig) {
      flowData.conflictConfig = {
        ...body.conflictConfig,
        // Normalize legacy "upsert" strategy to "update"
        strategy:
          body.conflictConfig.strategy === "upsert"
            ? "update"
            : body.conflictConfig.strategy,
      };
    }
    if (body.paginationConfig) {
      flowData.paginationConfig = body.paginationConfig;
    }
    if (body.typeCoercions) {
      flowData.typeCoercions = body.typeCoercions;
    }
    if (body.batchSize) {
      flowData.batchSize = Number(body.batchSize);
    }
  } else {
    flowData.dataSourceId = new Types.ObjectId(body.dataSourceId);
    flowData.entityFilter = body.entityFilter || [];
    // Ensure numeric fields in queries are properly typed
    flowData.queries = (body.queries || []).map((q: any) => ({
      ...q,
      batch_size: q.batch_size ? Number(q.batch_size) : undefined,
      batchSize: q.batchSize ? Number(q.batchSize) : undefined,
    }));
  }

  // Add table destination if specified
  if (body.tableDestination?.connectionId) {
    const td: any = {
      connectionId: new Types.ObjectId(body.tableDestination.connectionId),
      database: body.tableDestination.database,
      schema: body.tableDestination.schema,
      tableName: body.tableDestination.tableName || "",
      createIfNotExists: body.tableDestination.createIfNotExists !== false,
    };
    if (body.tableDestination.partitioning) {
      td.partitioning = body.tableDestination.partitioning;
    }
    if (body.tableDestination.clustering) {
      td.clustering = body.tableDestination.clustering;
    }
    flowData.tableDestination = td;
  }

  const destinationDriver = databaseRegistry.getDriver(destinationType ?? "");
  if (
    flowData.syncEngine === "cdc" &&
    destinationDriver?.requiresSoftDeleteForCdc?.()
  ) {
    // Destination's CDC path relies on tombstones for correctness.
    flowData.deleteMode = "soft";
  } else if (body.deleteMode) {
    flowData.deleteMode = body.deleteMode;
  }
  if (body.entityLayouts && Array.isArray(body.entityLayouts)) {
    flowData.entityLayouts = body.entityLayouts;
  }

  if (!webhookOn) {
    const scheduleEnabled = body.schedule?.enabled === true;
    flowData.schedule = {
      enabled: scheduleEnabled,
      cron: scheduleEnabled ? body.schedule?.cron || body.schedule : undefined,
      timezone: scheduleEnabled
        ? body.schedule?.timezone || body.timezone || "UTC"
        : undefined,
    };
  } else {
    // Unified trigger model: a webhook flow may also carry a poll
    // schedule (hybrid trigger set). Persist it so the scheduler's
    // trigger-based selection picks it up.
    if (body.schedule?.enabled === true) {
      flowData.schedule = {
        enabled: true,
        cron: body.schedule?.cron,
        timezone: body.schedule?.timezone || body.timezone || "UTC",
      };
    }
    // Generate webhook configuration
    const webhookEndpoint = generateWebhookEndpoint(
      workspaceId,
      new Types.ObjectId().toString(),
    );
    // Webhook secret must be provided by the user (from Stripe/Close)
    // The same value secretChange judged: a string, trimmed; anything else
    // is no secret, so a non-string can never slip past the admin gate.
    const webhookSecret =
      typeof body.webhookSecret === "string" ? body.webhookSecret.trim() : "";

    flowData.webhookConfig = {
      endpoint: webhookEndpoint,
      secret: webhookSecret,
      enabled: true,
    };
  }

  let createIncremental: IncrementalCapabilities | undefined;
  if (sourceType !== "database" && body.dataSourceId) {
    const ds = await SourceConnection.findOne(
      inWorkspace(body.dataSourceId, workspaceId),
    )
      .select({ type: 1, config: 1 })
      .lean();
    createIncremental = resolveConnectorIncrementalCapabilities(ds as any);
  }
  const createValidation = validateWriteMode({
    writeMode: flowData.writeMode,
    syncMode: flowData.syncMode,
    destinationType,
    syncEngine: flowData.syncEngine,
    webhookEnabled: webhookOn,
    selectedEntities: selectedEntitiesFromFlowBody({
      entityFilter: flowData.entityFilter,
      entityLayouts: flowData.entityLayouts,
    }),
    incremental: createIncremental,
    enforceIncrementalCapability: true,
  });
  if (createValidation.error) {
    throw new FlowRequestError(400, createValidation.error);
  }
  const syncConfigWarnings = createValidation.warnings;

  // The create forms have always POSTed a synthesized `name`; until this
  // field existed Mongoose silently dropped it. Persist it, fall back to
  // the shared derivation, and mint the slug that names the flow's file
  // (RFC #904) — once, here; a later rename never moves it.
  const requestedName =
    typeof body.name === "string" && body.name.trim()
      ? body.name.trim().slice(0, 200)
      : await deriveFlowDisplayName(flowData as unknown as IFlow);
  flowData.name = requestedName;
  // Files at main without a row yet are part of the identity space too.
  flowData.slug = await reserveFlowSlug(
    workspaceId,
    requestedName,
    new Set(
      (await listFlowDefinitionsAtMain(workspaceId)).map(def => def.slug),
    ),
  );

  const flow = new Flow(flowData);

  // Update webhook endpoint with actual flow ID
  if (webhookOn && flow.webhookConfig) {
    flow.webhookConfig.endpoint = generateWebhookEndpoint(
      workspaceId,
      flow._id.toString(),
    );
  }

  return { flow, flowData, sourceType, warnings: syncConfigWarnings };
}

/**
 * After a create is persisted: make sure the destination dataset exists for
 * connector flows, and populate the references the response shows.
 */
export async function finishFlowCreate(params: {
  flow: FlowDocument;
  flowData: Record<string, any>;
  sourceType: string;
}): Promise<void> {
  const { flow, flowData, sourceType } = params;
  // Pre-create BigQuery dataset for connector flows (tables created on first write with full schema)
  if (
    sourceType === "connector" &&
    flowData.tableDestination?.connectionId &&
    flowData.tableDestination?.schema
  ) {
    try {
      // createDestinationWriter.initialize() calls ensureSchema which creates the dataset
      // The flow's own destination: written as Mako, like its syncs.
      await asSystem(() =>
        createDestinationWriter(
          {
            workspaceId: flow.workspaceId,
            destinationDatabaseId: flowData.destinationDatabaseId,
            tableDestination: flowData.tableDestination,
          },
          "pre-check",
        ),
      );
      logger.info("BigQuery dataset ensured", {
        dataset: flowData.tableDestination.schema,
      });
    } catch (preCreateError) {
      logger.warn("Failed to ensure BigQuery dataset", {
        error:
          preCreateError instanceof Error
            ? preCreateError.message
            : String(preCreateError),
      });
    }
  }

  // Populate references for response based on source type
  if (sourceType === "connector" && flow.dataSourceId) {
    await flow.populate("dataSourceId", "name type");
  }
  await flow.populate("destinationDatabaseId", "name type");
}

/** What the post-save webhook reconcile compares against. */
export function webhookStateBefore(flow: FlowDocument) {
  return {
    entitySignature: flowEntitySignature(flow),
    webhookOn: hasWebhookTrigger(flow),
  };
}

/**
 * Patch `flow` from an update request. Returns the sync-config warnings the
 * response carries.
 */
export async function applyFlowUpdate(params: {
  workspaceId: string;
  flow: FlowDocument;
  body: FlowRequestBody;
}): Promise<string[]> {
  const { workspaceId, flow, body } = params;
  // Update common fields. Under the unified trigger model any flow may
  // carry a poll schedule (hybrid trigger set), not only type=scheduled.
  if (body.schedule) {
    const scheduleEnabled = body.schedule.enabled === true;
    flow.schedule = {
      enabled: scheduleEnabled,
      cron: scheduleEnabled
        ? body.schedule.cron || body.schedule
        : flow.schedule?.cron,
      timezone: scheduleEnabled
        ? body.schedule.timezone || flow.schedule?.timezone || "UTC"
        : flow.schedule?.timezone,
    };
  }
  // Rename changes the DISPLAY name only: `slug` is the filename identity
  // and never moves (RFC #904 / apps.md §23).
  if (typeof body.name === "string" && body.name.trim()) {
    flow.name = body.name.trim().slice(0, 200);
  }
  if (body.destinationDatabaseName !== undefined) {
    flow.destinationDatabaseName =
      typeof body.destinationDatabaseName === "string" &&
      body.destinationDatabaseName.trim().length > 0
        ? body.destinationDatabaseName.trim()
        : undefined;
  }
  const previousSyncMode = flow.syncMode;
  if (body.syncMode) flow.syncMode = body.syncMode;
  const syncConfigTouched =
    body.syncMode !== undefined ||
    body.writeMode !== undefined ||
    body.entityFilter !== undefined ||
    body.entityLayouts !== undefined ||
    body.dataSourceId !== undefined;

  if (body.writeMode !== undefined) {
    (flow as any).writeMode = body.writeMode;
  }

  let syncConfigWarnings: string[] = [];
  if (syncConfigTouched) {
    const destForWriteMode = await DatabaseConnection.findOne(
      inWorkspace(
        flow.tableDestination?.connectionId || flow.destinationDatabaseId,
        flow.workspaceId,
      ),
    )
      .select({ type: 1 })
      .lean();

    let updateIncremental: IncrementalCapabilities | undefined;
    if (flow.sourceType !== "database" && flow.dataSourceId) {
      const ds = await SourceConnection.findOne(
        inWorkspace(flow.dataSourceId, flow.workspaceId),
      )
        .select({ type: 1, config: 1 })
        .lean();
      updateIncremental = resolveConnectorIncrementalCapabilities(ds as any);
    }

    const selectedEntities = selectedEntitiesFromFlowBody({
      entityFilter: body.entityFilter ?? flow.entityFilter,
      entityLayouts: body.entityLayouts ?? (flow as any).entityLayouts,
    });

    // Hard-reject incremental+none only when the client is actively
    // editing sync mode / entities — don't break unrelated updates of
    // legacy flows that were saved as Incremental before capability
    // declarations existed.
    const enforceIncrementalCapability =
      body.syncMode !== undefined ||
      body.entityFilter !== undefined ||
      body.entityLayouts !== undefined ||
      previousSyncMode !== "incremental";

    const updateValidation = validateWriteMode({
      writeMode: (flow as any).writeMode,
      syncMode: flow.syncMode,
      destinationType: destForWriteMode?.type,
      syncEngine: flow.syncEngine,
      webhookEnabled: Boolean(
        flow.webhookConfig?.enabled && flow.webhookConfig?.endpoint,
      ),
      selectedEntities,
      incremental: updateIncremental,
      enforceIncrementalCapability,
    });
    if (updateValidation.error) {
      throw new FlowRequestError(400, updateValidation.error);
    }
    syncConfigWarnings = updateValidation.warnings;
  }

  // Update connector source specific fields
  if (flow.sourceType !== "database") {
    if (body.entityFilter !== undefined) {
      flow.entityFilter = body.entityFilter;
    }
    if (body.queries !== undefined) {
      // Ensure numeric fields in queries are properly typed
      flow.queries = body.queries.map((q: any) => ({
        ...q,
        batch_size: q.batch_size ? Number(q.batch_size) : undefined,
        batchSize: q.batchSize ? Number(q.batchSize) : undefined,
      }));
    }
  }

  // Update database source specific fields
  if (flow.sourceType === "database") {
    // Validate query safety if query is being updated
    if (body.databaseSource?.query) {
      const safetyCheck = checkQuerySafety(body.databaseSource.query);
      if (!safetyCheck.safe) {
        throw new FlowRequestError(
          400,
          `Unsafe query: ${safetyCheck.errors.join("; ")}`,
          { safetyCheck },
        );
      }
    }

    // Merge databaseSource object to avoid missing fields
    if (body.databaseSource) {
      const newConnectionId = body.databaseSource.connectionId
        ? new Types.ObjectId(body.databaseSource.connectionId)
        : flow.databaseSource?.connectionId;

      if (!newConnectionId) {
        throw new FlowRequestError(
          400,
          "databaseSource.connectionId is required",
        );
      }
      if (
        body.databaseSource.connectionId &&
        !(await DatabaseConnection.exists({
          _id: newConnectionId,
          workspaceId: new Types.ObjectId(workspaceId),
        }))
      ) {
        throw new FlowRequestError(404, "Source database connection not found");
      }

      flow.databaseSource = {
        connectionId: newConnectionId,
        database: body.databaseSource.database ?? flow.databaseSource?.database,
        query: body.databaseSource.query ?? flow.databaseSource?.query ?? "",
      };
    }

    // Update other database source config fields
    if (body.incrementalConfig !== undefined) {
      flow.incrementalConfig = body.incrementalConfig;
    }
    if (body.conflictConfig !== undefined) {
      flow.conflictConfig = body.conflictConfig
        ? {
            ...body.conflictConfig,
            // Normalize legacy "upsert" strategy to "update"
            strategy:
              body.conflictConfig.strategy === "upsert"
                ? "update"
                : body.conflictConfig.strategy,
          }
        : body.conflictConfig;
    }
    if (body.paginationConfig !== undefined) {
      flow.paginationConfig = body.paginationConfig;
    }
    if (body.typeCoercions !== undefined) {
      flow.typeCoercions = body.typeCoercions;
    }
    if (body.batchSize !== undefined) {
      flow.batchSize = Number(body.batchSize);
    }
  }

  // Update table destination - merge entire object to avoid missing fields
  if (body.tableDestination) {
    const newConnectionId = body.tableDestination.connectionId
      ? new Types.ObjectId(body.tableDestination.connectionId)
      : flow.tableDestination?.connectionId;

    if (!newConnectionId) {
      throw new FlowRequestError(
        400,
        "tableDestination.connectionId is required",
      );
    }
    if (
      body.tableDestination.connectionId &&
      !(await DatabaseConnection.exists({
        _id: newConnectionId,
        workspaceId: new Types.ObjectId(workspaceId),
      }))
    ) {
      throw new FlowRequestError(
        404,
        "Destination database connection not found",
      );
    }

    flow.tableDestination = {
      connectionId: newConnectionId,
      database:
        body.tableDestination.database ?? flow.tableDestination?.database,
      schema: body.tableDestination.schema ?? flow.tableDestination?.schema,
      tableName:
        body.tableDestination.tableName ??
        flow.tableDestination?.tableName ??
        "",
      createIfNotExists:
        body.tableDestination.createIfNotExists ??
        flow.tableDestination?.createIfNotExists ??
        true,
    };

    const resolvedPartitioning =
      body.tableDestination.partitioning ?? flow.tableDestination?.partitioning;
    if (resolvedPartitioning) {
      flow.tableDestination.partitioning = resolvedPartitioning;
    }
    const resolvedClustering =
      body.tableDestination.clustering ?? flow.tableDestination?.clustering;
    if (resolvedClustering) {
      flow.tableDestination.clustering = resolvedClustering;
    }

    // Keep destinationDatabaseId in sync (used for population/lookups)
    if (body.tableDestination.connectionId) {
      flow.destinationDatabaseId = new Types.ObjectId(
        body.tableDestination.connectionId,
      );
    }
  }

  // Keyed on the engine (not `type`): any CDC flow writing to a
  // destination whose CDC MERGE path relies on tombstones must stay on
  // soft delete, including scheduled CDC flows.
  if (flow.syncEngine === "cdc") {
    const effectiveDestConnectionId =
      flow.tableDestination?.connectionId || flow.destinationDatabaseId;
    const destination = await DatabaseConnection.findOne(
      inWorkspace(effectiveDestConnectionId, flow.workspaceId),
    )
      .select({ type: 1 })
      .lean();
    const destinationDriver = databaseRegistry.getDriver(
      destination?.type ?? "",
    );
    if (destinationDriver?.requiresSoftDeleteForCdc?.()) {
      // Force soft delete for destinations whose CDC path needs tombstones.
      flow.deleteMode = "soft";
    } else if (body.deleteMode !== undefined) {
      flow.deleteMode = body.deleteMode;
    }
  } else if (body.deleteMode !== undefined) {
    flow.deleteMode = body.deleteMode;
  }
  if (body.entityLayouts !== undefined) {
    (flow as any).entityLayouts = body.entityLayouts;
  }

  // Periodic full backfill cadence (CDC flows only). The dedicated
  // /backfill-schedule endpoint offers the same behavior for API consumers.
  if (body.backfillSchedule !== undefined && flow.syncEngine === "cdc") {
    const sched = body.backfillSchedule || {};
    const enabled = Boolean(sched.enabled);
    const cron = typeof sched.cron === "string" ? sched.cron.trim() : "";
    const next = {
      enabled,
      cron: enabled ? cron : flow.backfillSchedule?.cron,
      timezone:
        typeof sched.timezone === "string" && sched.timezone.trim()
          ? sched.timezone.trim()
          : flow.backfillSchedule?.timezone || "UTC",
    };
    flow.backfillSchedule = {
      ...next,
      entities: flow.backfillSchedule?.entities,
      // A new or changed resync first runs at its next tick.
      lastRunAt: resyncLastRunAt(flow.backfillSchedule, next),
    };
  }

  // Switching webhooks on gives any flow its inbound URL, minted once with
  // the same formula as a webhook flow's. Polling is untouched: webhooks
  // only add speed on top of it.
  if (body.webhookConfig?.enabled === true && !flow.webhookConfig?.endpoint) {
    flow.webhookConfig = {
      ...((flow.webhookConfig as unknown as Record<string, unknown>) ?? {}),
      endpoint: generateWebhookEndpoint(
        workspaceId as string,
        flow._id.toString(),
      ),
      enabled: true,
    } as typeof flow.webhookConfig;
  }

  // Update webhook-specific fields
  if (isWebhookFlow(flow) && flow.webhookConfig) {
    flow.webhookConfig.endpoint = generateWebhookEndpoint(
      workspaceId as string,
      flow._id.toString(),
    );
    // A save may set the signing secret (pasted from the provider), never
    // clear it: an empty secret reads as "never provisioned", and the next
    // save would provision again.
    if (typeof body.webhookSecret === "string" && body.webhookSecret.trim()) {
      flow.webhookConfig.secret = body.webhookSecret.trim();
    }
    if (body.webhookConfig) {
      if (body.webhookConfig.enabled !== undefined) {
        flow.webhookConfig.enabled = body.webhookConfig.enabled;
      }
    }
  }

  // Normalize legacy "upsert" strategy to "update" before saving
  if (flow.conflictConfig?.strategy === "upsert") {
    flow.conflictConfig.strategy = "update";
  }

  return syncConfigWarnings;
}

/**
 * After an update is persisted: re-target the provider webhook subscription
 * when the entities or the webhook switch changed, then populate the
 * references the response shows. Appends to `syncConfigWarnings`.
 */
export async function finishFlowUpdate(params: {
  flow: FlowDocument;
  before: ReturnType<typeof webhookStateBefore>;
  syncConfigWarnings: string[];
  /** The actor is owner/admin: the save may create a subscription. */
  mayProvision: boolean;
}): Promise<void> {
  const { flow, syncConfigWarnings } = params;
  const entitySignatureBefore = params.before.entitySignature;
  const webhookOnBefore = params.before.webhookOn;
  // Enabling or disabling an entity changes which provider events the
  // flow needs, and switching webhooks on needs a subscription at all
  // (adopted by URL, created only when none exists). Best-effort: a
  // provider failure surfaces as a warning, never as a failed save, and
  // polling carries on.
  if (
    isWebhookFlow(flow) &&
    (flowEntitySignature(flow) !== entitySignatureBefore ||
      !webhookOnBefore ||
      !flow.webhookConfig?.secret)
  ) {
    const webhookSync = await syncFlowWebhookSubscription(flow, {
      mayProvision: params.mayProvision,
    });
    if (webhookSync.status === "failed") {
      syncConfigWarnings.push(
        `Saved, but the provider webhook subscription could not be set up: ${webhookSync.error}. The flow keeps polling; fix the cause and save again, or re-provision from the Triggers step.`,
      );
    } else if (
      webhookSync.status === "skipped" &&
      webhookSync.reason === PROVISION_NEEDS_ADMIN
    ) {
      syncConfigWarnings.push(
        "Saved, but only an owner or admin can set up the provider webhook subscription. Ask one to save this flow or use “Create in …” on the Triggers step. The flow keeps polling.",
      );
    } else if (webhookSync.status === "not_found") {
      syncConfigWarnings.push(
        "Saved, but no provider webhook subscription points at this flow's URL. Re-provision the webhook from the Triggers step so new entities receive events.",
      );
    }
  }

  // Populate references for response based on source type
  if (flow.sourceType !== "database" && flow.dataSourceId) {
    await flow.populate("dataSourceId", "name type");
  }
  await flow.populate("destinationDatabaseId", "name type");
}

export const SECRET_NEEDS_ADMIN =
  "Only an owner or admin can change a flow's webhook signing secret.";

/**
 * The request sets a signing secret other than the one the flow holds. Only
 * an owner or admin may: the secret decides which signed events the flow
 * accepts. Re-sending the current secret (a form save) is no change.
 */
export function secretChange(
  body: { webhookSecret?: unknown },
  current: string | undefined,
): boolean {
  const next =
    typeof body.webhookSecret === "string" ? body.webhookSecret.trim() : "";
  return next.length > 0 && next !== (current ?? "").trim();
}
