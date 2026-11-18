/* eslint-disable no-console */
/**
 * READ-ONLY gate for deleting the in-process built-in connectors.
 *
 * Run it against production before the PR that deletes them merges. It
 * prints, per built-in type (connectors/twins/types.ts), every flow that
 * would change behaviour at merge, and exits 1 while any gate is open.
 *
 * The gates, per type:
 *   1. builtinActive = 0. A flow on a connection of this type that runs the
 *      built-in path: not boxed (no `connectorRuntime: boxed`, no `shadowOf`,
 *      no `replaces`) and with any trigger on (poll `schedule.enabled`,
 *      `webhookConfig.enabled`, `backfillSchedule.enabled`), or with an
 *      execution still running.
 *   2. rollbackKept = 0. A built-in flow paused by the boxed switch still
 *      holds its rollback (`boxedSwitch`). Once the twin flow has run long
 *      enough that nobody will switch back, delete the paused flow (or clear
 *      `boxedSwitch` with an owner/admin `flow_update`). After merge a
 *      switch back would run the same twin, not the in-process code.
 *   3. inlinePending = 0. Webhook events of these flows that the inline
 *      (non-box) lane has not finished: `status` pending or processing,
 *      no `lane: "box"`.
 *
 * It also lists, informationally, connections of each type in workspaces
 * with no `connectors/<type>/` folder. After merge those resolve to
 * `mako/<type>@1` in the registry, so CONNECTOR_REGISTRY_ENABLED must be on
 * and that version published.
 *
 * Safety: find / countDocuments / aggregate only. No writes.
 *
 * Usage:
 *   DATABASE_URL="$PROD_DATABASE_URL" \
 *     pnpm --filter api exec tsx src/scripts/builtin-twins-premerge-check.ts
 * BUILTIN_TYPES=close,stripe narrows the types checked.
 */
import path from "path";
import fs from "fs";
import dotenv from "dotenv";
import mongoose, { type Types } from "mongoose";
import { BUILTIN_TWIN_TYPES } from "../connectors/twins/types";

const envPath = path.resolve(__dirname, "../../../.env");
if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath, quiet: true });
}

/** Plain types the gate has to cover, even before a commit adds their twin. */
const EXTRA_TYPES = ["graphql", "bigquery"];

interface FlowRow {
  _id: Types.ObjectId;
  name?: string;
  workspaceId?: Types.ObjectId;
  dataSourceId?: Types.ObjectId;
  connectorRuntime?: string;
  shadowOf?: Types.ObjectId;
  replaces?: Types.ObjectId;
  boxedSwitch?: { to?: Types.ObjectId; at?: Date };
  schedule?: { enabled?: boolean };
  webhookConfig?: { enabled?: boolean };
  backfillSchedule?: { enabled?: boolean };
}

function isBoxed(flow: FlowRow): boolean {
  return (
    flow.connectorRuntime === "boxed" ||
    Boolean(flow.shadowOf) ||
    Boolean(flow.replaces)
  );
}

function triggersOn(flow: FlowRow): string[] {
  const on: string[] = [];
  if (flow.schedule?.enabled) on.push("poll");
  if (flow.webhookConfig?.enabled) on.push("webhook");
  if (flow.backfillSchedule?.enabled) on.push("resync");
  return on;
}

async function main(): Promise<void> {
  const uri = process.env.DATABASE_URL;
  if (!uri) {
    console.error("No DATABASE_URL set. Aborting.");
    process.exit(2);
  }
  const types = (
    process.env.BUILTIN_TYPES?.split(",").map(t => t.trim()) ?? [
      ...BUILTIN_TWIN_TYPES,
      ...EXTRA_TYPES.filter(t => !(BUILTIN_TWIN_TYPES as string[]).includes(t)),
    ]
  ).filter(Boolean);

  await mongoose.connect(uri, {
    maxPoolSize: 5,
    serverSelectionTimeoutMS: 8000,
  });
  const db = mongoose.connection.db;
  if (!db) throw new Error("No database handle after connect");

  let open = 0;
  for (const type of types) {
    const connections = await db
      .collection("connectors")
      .find({ type }, { projection: { _id: 1, name: 1, workspaceId: 1 } })
      .toArray();
    const ids = connections.map(c => c._id);
    const flows = (await db
      .collection("flows")
      .find(
        { sourceType: { $ne: "database" }, dataSourceId: { $in: ids } },
        {
          projection: {
            name: 1,
            workspaceId: 1,
            dataSourceId: 1,
            connectorRuntime: 1,
            shadowOf: 1,
            replaces: 1,
            boxedSwitch: 1,
            "schedule.enabled": 1,
            "webhookConfig.enabled": 1,
            "backfillSchedule.enabled": 1,
          },
        },
      )
      .toArray()) as unknown as FlowRow[];

    const builtinFlows = flows.filter(flow => !isBoxed(flow));
    const builtinIds = builtinFlows.map(flow => flow._id);
    const running = new Set(
      (
        await db
          .collection("flow_executions")
          .find(
            { flowId: { $in: builtinIds }, status: "running" },
            { projection: { flowId: 1 } },
          )
          .toArray()
      ).map(row => String(row.flowId)),
    );
    const active = builtinFlows.filter(
      flow => triggersOn(flow).length > 0 || running.has(String(flow._id)),
    );
    const rollback = builtinFlows.filter(flow => flow.boxedSwitch);
    const inlinePending = await db.collection("webhookevents").countDocuments({
      flowId: { $in: flows.map(flow => flow._id) },
      status: { $in: ["pending", "processing"] },
      lane: { $ne: "box" },
    });

    const workspaces = [
      ...new Set(connections.map(c => String(c.workspaceId))),
    ];
    const withFolder = new Set(
      (
        await db
          .collection("connectordefinitions")
          .find(
            {
              slug: type,
              workspaceId: {
                $in: connections.map(c => c.workspaceId).filter(Boolean),
              },
            },
            { projection: { workspaceId: 1 } },
          )
          .toArray()
      ).map(row => String(row.workspaceId)),
    );
    const registryOnly = workspaces.filter(w => !withFolder.has(w));

    const gateOpen =
      active.length > 0 || rollback.length > 0 || inlinePending > 0;
    if (gateOpen) open += 1;
    console.log(
      `\n${type}: ${gateOpen ? "OPEN" : "ok"} | connections=${connections.length} ` +
        `flows=${flows.length} boxed=${flows.length - builtinFlows.length} ` +
        `builtinActive=${active.length} rollbackKept=${rollback.length} ` +
        `inlinePending=${inlinePending} registryOnlyWorkspaces=${registryOnly.length}`,
    );
    for (const flow of active) {
      console.log(
        `  builtinActive  ${flow._id} ${flow.name ?? ""} ws=${flow.workspaceId} ` +
          `triggers=${triggersOn(flow).join("+") || "-"}${running.has(String(flow._id)) ? " running" : ""}`,
      );
    }
    for (const flow of rollback) {
      console.log(
        `  rollbackKept   ${flow._id} ${flow.name ?? ""} ws=${flow.workspaceId} ` +
          `twin=${flow.boxedSwitch?.to ?? "?"} switchedAt=${flow.boxedSwitch?.at?.toISOString?.() ?? "?"}`,
      );
    }
    for (const workspaceId of registryOnly) {
      console.log(`  registryOnly   ws=${workspaceId} -> mako/${type}@1`);
    }
  }

  console.log(
    open === 0
      ? "\nAll gates closed: the built-ins can be deleted."
      : `\n${open} type(s) still have an open gate. Do not merge.`,
  );
  await mongoose.disconnect();
  process.exit(open === 0 ? 0 : 1);
}

main().catch(error => {
  console.error(error);
  process.exit(2);
});
