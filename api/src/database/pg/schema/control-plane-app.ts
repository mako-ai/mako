/**
 * Small app control-plane tables moved off MongoDB (migration `0012`):
 *
 *   1. `notification_rules`        (Mongo `notification_rules`; run-terminal alert rules)
 *   2. `notification_deliveries`   (Mongo `notification_deliveries`; 90d TTL reaper on `created_at`)
 *   3. `workflow_recorded_runs`    (Mongo `workflow_recorded_runs`; per-run dry-run write counter, 7d TTL)
 *   4. `workflow_recorded_writes`  (Mongo `workflow_recorded_writes`; dry-run requests, 7d TTL)
 *   5. `model_catalog_snapshots`   (Mongo `modelcatalogsnapshots`; global gateway/pricing/curation docs)
 *   6. `apps_box_policy`           (Mongo `apps_box_policy`; global idle-policy tracking start)
 *
 * Conventions:
 *   - `notification_rules.id` is minted with `newDualId()` so 24-hex rule IDs keep
 *     working on `routes/notification-rules.ts`; every other UUID PK is native UUIDv7.
 *   - `resource_id` and `connection_id` are soft UUID refs. Flows stay in MongoDB, so a
 *     flow's ObjectId is stored as its `objectIdToUuid()` form and served via `toWireId()`.
 *   - `channel` holds the already-encrypted channel object verbatim. Never re-encrypt it.
 *   - `workflow_recorded_writes.user_id` stays `text`: sandbox runs carry arbitrary
 *     person strings, not only `users.id` UUIDs.
 */
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { users } from "./auth";
import { workspaces } from "./workspaces";

export const NOTIFICATION_RESOURCE_TYPES = ["scheduled_query", "flow"] as const;
export type NotificationResourceTypePg =
  (typeof NOTIFICATION_RESOURCE_TYPES)[number];

export const NOTIFICATION_DELIVERY_STATUSES = [
  "pending",
  "sent",
  "failed",
  "skipped",
] as const;
export type NotificationDeliveryStatusPg =
  (typeof NOTIFICATION_DELIVERY_STATUSES)[number];

export const MODEL_CATALOG_SNAPSHOT_IDS = [
  "gateway",
  "gateway-raw",
  "arena",
  "pricing",
  "curation",
  "capabilities",
] as const;
export type ModelCatalogSnapshotIdPg =
  (typeof MODEL_CATALOG_SNAPSHOT_IDS)[number];

export const notificationRules = pgTable(
  "notification_rules",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    resourceType: text("resource_type")
      .$type<NotificationResourceTypePg>()
      .notNull(),
    /** Soft UUID ref: `saved_consoles.id` or a MongoDB flow `_id` via `objectIdToUuid()`. */
    resourceId: uuid("resource_id").notNull(),
    // Only rows copied by the backfill participate in source deletion reconciliation.
    importedFromMongo: boolean("imported_from_mongo").notNull().default(false),
    enabled: boolean("enabled").notNull().default(true),
    triggers: text("triggers").array().notNull(),
    /** Encrypted channel object, stored verbatim. */
    channel: jsonb("channel").$type<Record<string, unknown>>().notNull(),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    /** Raw creator string as the API received it (user id or sentinel). */
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  table => [
    check(
      "notification_rules_resource_type_check",
      sql`${table.resourceType} IN ('scheduled_query', 'flow')`,
    ),
    index("idx_notification_rules_ws_resource_enabled").on(
      table.workspaceId,
      table.resourceType,
      table.resourceId,
      table.enabled,
    ),
  ],
);

export const notificationDeliveries = pgTable(
  "notification_deliveries",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    // Keep the original rule ID throughout the delivery history retention period.
    ruleId: uuid("rule_id").notNull(),
    resourceType: text("resource_type")
      .$type<NotificationResourceTypePg>()
      .notNull(),
    resourceId: uuid("resource_id").notNull(),
    runId: text("run_id").notNull(),
    trigger: text("trigger").notNull(),
    channelType: text("channel_type").notNull(),
    idempotencyKey: text("idempotency_key").notNull().unique(),
    status: text("status").$type<NotificationDeliveryStatusPg>().notNull(),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    httpStatus: integer("http_status"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  table => [
    check(
      "notification_deliveries_status_check",
      sql`${table.status} IN ('pending', 'sent', 'failed', 'skipped')`,
    ),
    index("idx_notification_deliveries_ws_resource_completed").on(
      table.workspaceId,
      table.resourceType,
      table.resourceId,
      table.completedAt.desc().nullsLast(),
      table.createdAt.desc(),
    ),
    index("idx_notification_deliveries_created_at").on(table.createdAt),
  ],
);

export const workflowRecordedRuns = pgTable(
  "workflow_recorded_runs",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    runId: text("run_id").notNull(),
    count: integer("count").notNull().default(0),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  table => [
    uniqueIndex("uq_workflow_recorded_runs_ws_run").on(
      table.workspaceId,
      table.runId,
    ),
    index("idx_workflow_recorded_runs_at").on(table.at),
  ],
);

export const workflowRecordedWrites = pgTable(
  "workflow_recorded_writes",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    runId: text("run_id").notNull(),
    /** A sandbox run's person (arbitrary string, not an FK). */
    userId: text("user_id"),
    /** Soft UUID ref -> connection id. */
    connectionId: uuid("connection_id").notNull(),
    connection: text("connection").notNull(),
    step: text("step"),
    request: jsonb("request").$type<Record<string, unknown>>().notNull(),
    seq: integer("seq").notNull(),
    bodyCut: boolean("body_cut"),
    wouldSend: boolean("would_send"),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  table => [
    uniqueIndex("uq_workflow_recorded_writes_ws_run_seq").on(
      table.workspaceId,
      table.runId,
      table.seq,
    ),
    index("idx_workflow_recorded_writes_at").on(table.at),
  ],
);

export const modelCatalogSnapshots = pgTable(
  "model_catalog_snapshots",
  {
    id: text("id").$type<ModelCatalogSnapshotIdPg>().primaryKey(),
    data: jsonb("data")
      .$type<unknown>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull(),
    itemCount: integer("item_count").notNull().default(0),
  },
  table => [
    check(
      "model_catalog_snapshots_id_check",
      sql`${table.id} IN ('gateway', 'gateway-raw', 'arena', 'pricing', 'curation', 'capabilities')`,
    ),
  ],
);

export const appsBoxPolicy = pgTable("apps_box_policy", {
  id: text("id").primaryKey(),
  since: timestamp("since", { withTimezone: true }).notNull(),
});
