import { describe, expect, it } from "vitest";
import type { FormData } from "./sync-flow-config";
import {
  buildSyncPayload,
  flowToFormData,
  layoutChangedEntities,
  validateSyncSubmission,
  SYNC_STEP,
  type SavedSyncFlow,
  type SyncSaveContext,
} from "./sync-flow-logic";

const baseForm = (over: Partial<FormData> = {}): FormData => ({
  dataSourceId: "src",
  destinationDatabaseId: "dst",
  destinationDatabaseName: "",
  tableDestination: { tablePrefix: "", schema: "analytics" },
  scheduleEnabled: true,
  scheduleCron: "0 * * * *",
  scheduleTimezone: "UTC",
  webhookEnabled: false,
  webhookSecret: "",
  syncMode: "incremental",
  writeMode: "append_dedup",
  deleteMode: "hard",
  backfillScheduleEnabled: false,
  backfillScheduleCron: "0 3 * * *",
  backfillScheduleTimezone: "UTC",
  entityFilter: [],
  entityLayouts: [],
  queries: [],
  ...over,
});

const ctx = (over: Partial<SyncSaveContext> = {}): SyncSaveContext => ({
  connectorSupportsWebhook: true,
  isCdcCapableDest: true,
  isBigQueryDest: false,
  requiresDestinationDatabaseName: false,
  hasTransferQueries: false,
  requiresQueries: false,
  layoutMode: "index",
  ...over,
});

const layout = (entity: string, over = {}) => ({
  entity,
  partitionField: "_syncedAt",
  partitionGranularity: "day" as const,
  clusterFields: ["id"],
  enabled: true,
  ...over,
});

describe("flowToFormData", () => {
  it("maps a saved flow onto the form, with trigger flags and defaults", () => {
    const { formData, cronMode } = flowToFormData(
      {
        dataSourceId: { _id: "src-1" },
        destinationDatabaseId: "dst-1",
        schedule: { enabled: true, cron: "*/7 * * * *" },
        webhookConfig: { enabled: true, endpoint: "https://x/hook" },
        syncMode: "full",
        tableDestination: { tableName: "crm", database: "db1" },
        entityLayouts: [layout("leads", { enabled: undefined })],
      } as unknown as SavedSyncFlow,
      "in-form-secret",
    );
    expect(formData).toMatchObject({
      dataSourceId: "src-1",
      destinationDatabaseId: "dst-1",
      scheduleEnabled: true,
      scheduleCron: "*/7 * * * *",
      scheduleTimezone: "UTC",
      webhookEnabled: true,
      // The list payload had no secret yet: keep the in-form one.
      webhookSecret: "in-form-secret",
      syncMode: "full",
      writeMode: "append_dedup",
      backfillScheduleCron: "0 3 * * *",
      tableDestination: { tablePrefix: "crm", schema: "db1" },
    });
    expect(formData.entityLayouts?.[0].enabled).toBe(true);
    expect(cronMode).toBe("custom");
  });

  it("treats a schedule without a cron as off and picks the preset mode", () => {
    const { formData, cronMode } = flowToFormData(
      { schedule: { enabled: true } } as unknown as SavedSyncFlow,
      undefined,
    );
    expect(formData.scheduleEnabled).toBe(false);
    expect(formData.scheduleCron).toBe("0 * * * *");
    expect(cronMode).toBe("preset");
    expect(formData.tableDestination).toBeUndefined();
  });
});

describe("layoutChangedEntities", () => {
  it("reports enabled entities whose partition or cluster layout changed", () => {
    const saved = [
      layout("a"),
      layout("b"),
      layout("c", { enabled: false }),
      layout("d"),
    ];
    const next = [
      layout("a", { partitionGranularity: "month" }),
      layout("b", { clusterFields: ["id"] }),
      layout("c", { partitionField: "x" }),
      layout("d", { clusterFields: ["id", "x"], enabled: false }),
      layout("new"),
    ];
    expect(layoutChangedEntities(saved, next)).toEqual(["a"]);
  });

  it("ignores cluster field order", () => {
    expect(
      layoutChangedEntities(
        [layout("a", { clusterFields: ["x", "y"] })],
        [layout("a", { clusterFields: ["y", "x"] })],
      ),
    ).toEqual([]);
  });
});

describe("validateSyncSubmission", () => {
  it("accepts a complete form", () => {
    expect(validateSyncSubmission(baseForm(), ctx())).toBeNull();
  });

  it.each([
    [
      "missing cron",
      baseForm({ scheduleCron: "  " }),
      ctx(),
      SYNC_STEP.triggers,
      /cron expression is required/,
    ],
    [
      "webhooks on a pull-only connector",
      baseForm({ webhookEnabled: true }),
      ctx({ connectorSupportsWebhook: false }),
      SYNC_STEP.triggers,
      /does not provide webhooks/,
    ],
    [
      "webhooks without a CDC destination",
      baseForm({ webhookEnabled: true }),
      ctx({ isCdcCapableDest: false }),
      SYNC_STEP.destination,
      /CDC-capable destination/,
    ],
    [
      "no BigQuery dataset",
      baseForm({ tableDestination: { schema: "" } }),
      ctx({ isBigQueryDest: true }),
      SYNC_STEP.destination,
      /dataset is required/,
    ],
    [
      "no database on a multi-database server",
      baseForm(),
      ctx({ isCdcCapableDest: false, requiresDestinationDatabaseName: true }),
      SYNC_STEP.destination,
      /select a destination database/,
    ],
    [
      "required queries missing",
      baseForm({ queries: [{ name: "q", query: " " }] }),
      ctx({ hasTransferQueries: true, requiresQueries: true }),
      SYNC_STEP.entities,
      /add at least one query/,
    ],
    [
      "optional queries and no built-in entity",
      baseForm(),
      ctx({ hasTransferQueries: true }),
      SYNC_STEP.entities,
      /Enable at least one built-in entity/,
    ],
    [
      "short reconcile cron",
      baseForm({
        backfillScheduleEnabled: true,
        backfillScheduleCron: "0 3 *",
      }),
      ctx(),
      SYNC_STEP.triggers,
      /periodic full reconcile/,
    ],
  ])("refuses %s", (_label, data, context, step, message) => {
    const result = validateSyncSubmission(data, context);
    expect(result?.step).toBe(step);
    expect(result?.message).toMatch(message);
  });
});

describe("buildSyncPayload", () => {
  const payloadCtx = (over = {}) => ({
    ...ctx(),
    name: "Src → Dst",
    isNewMode: true,
    ...over,
  });

  it("builds a CDC create payload; all entities enabled means no filter", () => {
    const payload = buildSyncPayload(
      baseForm({
        webhookEnabled: true,
        webhookSecret: "s",
        scheduleCron: " 0 * * * * ",
        entityLayouts: [layout("a"), layout("b")],
      }),
      payloadCtx(),
    );
    expect(payload).toMatchObject({
      name: "Src → Dst",
      schedule: { enabled: true, cron: "0 * * * *", timezone: "UTC" },
      webhookSecret: "s",
      webhookConfig: { enabled: true },
      deleteMode: "hard",
      backfillSchedule: { enabled: false, cron: "0 3 * * *", timezone: "UTC" },
      tableDestination: {
        connectionId: "dst",
        schema: "analytics",
        tableName: "",
        createIfNotExists: true,
      },
      entityFilter: [],
    });
    expect(payload.entityLayouts).toHaveLength(2);
  });

  it("only sends webhookConfig on edit when the toggle changed", () => {
    const existingFlow = {
      webhookConfig: { enabled: true, endpoint: "https://x" },
    } as unknown as SavedSyncFlow;
    const unchanged = buildSyncPayload(baseForm({ webhookEnabled: true }), {
      ...payloadCtx({ isNewMode: false }),
      existingFlow,
    });
    expect(unchanged.webhookConfig).toBeUndefined();
    const turnedOff = buildSyncPayload(baseForm(), {
      ...payloadCtx({ isNewMode: false }),
      existingFlow,
    });
    expect(turnedOff.webhookConfig).toEqual({ enabled: false });
  });

  it("forces soft deletes on BigQuery and skips layouts without a layout mode", () => {
    const payload = buildSyncPayload(
      baseForm({
        entityLayouts: [layout("a"), layout("b", { enabled: false })],
      }),
      payloadCtx({ isBigQueryDest: true, layoutMode: "none" }),
    );
    expect(payload.deleteMode).toBe("soft");
    expect(payload.entityFilter).toEqual(["a"]);
    expect(payload.entityLayouts).toBeUndefined();
  });

  it("non-CDC destinations name the database instead of a table destination", () => {
    const payload = buildSyncPayload(
      baseForm({ destinationDatabaseName: " crm " }),
      payloadCtx({ isCdcCapableDest: false }),
    );
    expect(payload.tableDestination).toBeUndefined();
    expect(payload.destinationDatabaseName).toBe("crm");
  });

  it("hybrid connectors persist built-ins plus query entities with layouts", () => {
    const payload = buildSyncPayload(
      baseForm({
        entityLayouts: [layout("surveys")],
        queries: [
          { name: " events ", query: "select 1" },
          { name: "", query: "select 2" },
        ],
      }),
      payloadCtx({ hasTransferQueries: true, layoutMode: "partition" }),
    );
    expect(payload.entityFilter).toEqual(["surveys", "events"]);
    expect(payload.entityLayouts).toEqual([
      layout("surveys"),
      {
        entity: "events",
        label: "events",
        partitionField: "_syncedAt",
        partitionGranularity: "day",
        clusterFields: ["_dataSourceId", "id"],
        enabled: true,
      },
    ]);
  });
});
