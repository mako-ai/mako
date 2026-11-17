/**
 * Boxed shadow and switch, the pure halves: which flows run boxed, the
 * credential the twin gets, shadow destinations, the flow file's runtime
 * keys, the parity SQL and the gate's arithmetic.
 *
 * Run: tsx src/connectors/boxed-runtime/boxed-runtime.test.ts
 */
import assert from "node:assert/strict";
import { Types } from "mongoose";

process.env.ENCRYPTION_KEY =
  process.env.ENCRYPTION_KEY ??
  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

import { Flow, type IFlow } from "../../database/workspace-schema";
import {
  flowToFile,
  parseFlowFileResult,
  serializeFlowFile,
} from "../../services/flow-config-files";
import { applyDefinition } from "../../services/flow-definition-apply";
import {
  approvalBinding,
  boxedKind,
  boxedTwinFor,
  configForTwin,
  isTwinCodeAllowed,
  sameDestination,
  type FlowRuntimeFields,
} from "./runtime";
import {
  buildColumnsSql,
  buildSamplesSql,
  buildSummarySql,
  comparableColumns,
  readSummaryRow,
} from "./parity-sql";
import {
  assertSafeName,
  entityReasons,
  parityCutoff,
  parityWindow,
} from "./parity.service";
import { shadowDataset } from "./shadow.service";

const KEY = "sk_live_never_in_a_message";
const spec = {
  connectionSpecification: {
    required: ["api_key"],
    properties: { api_key: {}, region: {} },
  },
};

// 1. Which flows run boxed: the flag, a built-in type in scope, the kind,
//    and a standing owner/admin approval bound to this flow.
{
  process.env.CONNECTOR_BOXED_SWITCH = "true";
  const conn = new Types.ObjectId();
  const db = new Types.ObjectId();
  const live = new Types.ObjectId();
  const flow = (extra: Record<string, unknown> = {}) =>
    ({
      dataSourceId: conn,
      destinationDatabaseId: db,
      tableDestination: { connectionId: db, schema: "pl_close", tableName: "" },
      ...extra,
    }) as any;
  const approve = (f: any, slug = "close") => ({
    ...f,
    boxedApproval: {
      by: "u",
      at: new Date(),
      kind: boxedKind(f),
      slug,
      ...approvalBinding(f),
      sourceSha: "s1",
    },
  });
  const boxed = (slug = "close", extra = {}) =>
    approve(flow({ connectorRuntime: "boxed", ...extra }), slug);
  assert.equal(boxedTwinFor(boxed(), "close"), "close");
  assert.equal(boxedTwinFor(boxed("stripe"), "stripe"), "stripe");
  assert.equal(
    boxedTwinFor(boxed("close-v2", { boxedConnector: "close-v2" }), "close"),
    "close-v2",
  );
  const shadow = approve(
    flow({
      shadowOf: live,
      tableDestination: { connectionId: db, schema: "pl_close_shadow" },
    }),
    "wise",
  );
  assert.equal(
    boxedTwinFor(shadow, "wise"),
    "wise",
    "a shadow by shadowOf alone",
  );
  assert.equal(
    boxedTwinFor(flow({ connectorRuntime: "boxed" }), "close"),
    null,
    "a file alone, with no approval, boxes nothing",
  );
  assert.equal(
    boxedTwinFor({ ...boxed(), boxedConnector: "evil" }, "close"),
    null,
    "the approval names the twin it allows",
  );
  assert.equal(
    boxedTwinFor({ ...boxed(), dataSourceId: new Types.ObjectId() }, "close"),
    null,
    "bound to the connection",
  );
  assert.equal(
    boxedTwinFor(
      { ...boxed(), tableDestination: { connectionId: db, schema: "other" } },
      "close",
    ),
    null,
    "bound to the destination",
  );
  const { shadowOf: _drop, ...unshadowed } = shadow;
  assert.equal(
    boxedTwinFor({ ...unshadowed, connectorRuntime: "boxed" }, "wise"),
    null,
    "a shadow's approval never boxes a live flow",
  );
  assert.equal(
    boxedTwinFor({ ...boxed(), shadowOf: live }, "close"),
    null,
    "a switch approval never boxes a shadow",
  );
  assert.equal(
    boxedTwinFor({ ...boxed(), connectorRuntime: "builtin" }, "close"),
    null,
  );
  assert.equal(boxedTwinFor(boxed(), "ws:close"), null, "already boxed");
  assert.equal(boxedTwinFor(boxed("rest"), "rest"), null, "not in scope");
  assert.equal(boxedTwinFor(boxed(), undefined), null);
  for (const type of ["pandadoc", "calendly", "claap", "posthog"]) {
    assert.equal(boxedTwinFor(boxed(type), type), type);
  }
  process.env.CONNECTOR_BOXED_SWITCH = "false";
  assert.equal(boxedTwinFor(boxed(), "close"), null, "flag off");
  delete process.env.CONNECTOR_BOXED_SWITCH;
  assert.equal(boxedTwinFor(boxed(), "close"), null, "flag unset");

  // The code the key may reach.
  const folder = (sourceSha: string, registry?: any) => ({
    sourceSha,
    registry,
  });
  assert.equal(
    isTwinCodeAllowed(folder("s1"), { sourceSha: "s1" }, "close"),
    true,
  );
  assert.equal(
    isTwinCodeAllowed(folder("s2"), { sourceSha: "s1" }, "close"),
    false,
  );
  assert.equal(isTwinCodeAllowed(folder("s2"), undefined, "close"), false);
  assert.equal(
    isTwinCodeAllowed(
      folder("s9", { slug: "close", hash: "h" }),
      { sourceSha: "s1" },
      "close",
    ),
    true,
    "Mako's registry connector for the same type",
  );
  assert.equal(
    isTwinCodeAllowed(
      folder("s9", { slug: "evil", hash: "h" }),
      { sourceSha: "s1" },
      "close",
    ),
    false,
  );

  // A file edit voids an approval when it moves what it is bound to.
  const row = new Flow({
    workspaceId: new Types.ObjectId(),
    createdBy: "u",
    sourceType: "connector",
    dataSourceId: conn,
    destinationDatabaseId: db,
    tableDestination: { connectionId: db, schema: "pl_close", tableName: "" },
    connectorRuntime: "boxed",
    name: "pl_close",
  }) as unknown as IFlow;
  const fileOf = (f: IFlow) => {
    const parsed = parseFlowFileResult(serializeFlowFile(flowToFile(f)));
    assert.ok(parsed.ok);
    return (parsed as { ok: true; file: any }).file;
  };
  const approveRow = () => {
    row.boxedApproval = approve(row).boxedApproval;
  };
  approveRow();
  const renamed = fileOf(row);
  renamed.name = "pl_close renamed";
  assert.equal(applyDefinition(row, renamed), null);
  assert.ok(row.boxedApproval, "a rename keeps the approval");
  for (const edit of [
    (f: any) => (f.destination.table.schema = "elsewhere"),
    (f: any) => (f.source.connectionId = String(new Types.ObjectId())),
    (f: any) => (f.boxedConnector = "evil"),
    (f: any) => (f.shadowOf = String(live)),
    (f: any) => delete f.runtime,
  ]) {
    approveRow();
    row.tableDestination = {
      connectionId: db,
      schema: "pl_close",
      tableName: "",
    } as any;
    row.dataSourceId = conn;
    row.connectorRuntime = "boxed";
    row.boxedConnector = undefined;
    row.shadowOf = undefined;
    approveRow();
    const file = fileOf(row);
    edit(file);
    assert.equal(applyDefinition(row, file), null);
    assert.equal(row.boxedApproval, undefined, `voided by ${edit.toString()}`);
  }
}

// 1b. Parity refuses names that are not plain before building SQL.
{
  assert.doesNotThrow(() => assertSafeName("dataset", "pl_close_shadow"));
  for (const bad of ["x`", "x\\", "a.b", "a b", "x\\` OR 1=1 --", ""]) {
    assert.throws(() => assertSafeName("dataset", bad), /not plain/);
  }
}

// 2. The twin gets the declared keys only; a missing required key is named,
//    its value never is.
{
  assert.deepEqual(
    configForTwin(
      { api_key: KEY, api_base_url: "https://proxy", region: "eu" },
      spec,
      "stripe",
    ),
    { api_key: KEY, region: "eu" },
  );
  assert.throws(
    () => configForTwin({ token: KEY }, spec, "stripe"),
    (error: Error) =>
      /lacks api_key/.test(error.message) && !error.message.includes(KEY),
  );
  assert.throws(
    () => configForTwin({ api_key: KEY }, {}, "stripe"),
    /declares no connectionSpecification/,
  );
}

// 3. A shadow's dataset, and what "the same destination" means.
{
  assert.equal(shadowDataset("pl_close"), "pl_close_shadow");
  const db = new Types.ObjectId();
  const flow = (schema: string, tableName = "") =>
    ({
      destinationDatabaseId: db,
      tableDestination: { connectionId: db, schema, tableName },
    }) as unknown as FlowRuntimeFields;
  assert.equal(sameDestination(flow("pl_close"), flow("pl_close")), true);
  assert.equal(
    sameDestination(flow("pl_close"), flow("pl_close_shadow")),
    false,
  );
  // The table prefix does not separate them: a shadow writes its own dataset.
  assert.equal(sameDestination(flow("x", "a"), flow("x", "b")), true);
  // The writer takes the connection from destinationDatabaseId: a different
  // tableDestination.connectionId or database does not separate them.
  const other = new Types.ObjectId();
  assert.equal(
    sameDestination(flow("pl_close"), {
      destinationDatabaseId: db,
      destinationDatabaseName: "elsewhere",
      tableDestination: {
        connectionId: other,
        database: "x",
        schema: "pl_close",
      },
    } as unknown as FlowRuntimeFields),
    true,
  );
  assert.equal(
    sameDestination(flow("public"), {
      destinationDatabaseId: db,
      tableDestination: { connectionId: db },
    } as unknown as FlowRuntimeFields),
    true,
    "an unset dataset is public, as the writer reads it",
  );
}

// 4. The flow file: runtime keys only when set, and they round-trip.
{
  const base = {
    _id: new Types.ObjectId(),
    workspaceId: new Types.ObjectId(),
    name: "pl_close",
    slug: "pl-close",
    sourceType: "connector",
    dataSourceId: new Types.ObjectId(),
    destinationDatabaseId: new Types.ObjectId(),
    tableDestination: { schema: "pl_close" },
    syncMode: "incremental",
    syncEngine: "cdc",
  } as unknown as IFlow;
  const plain = serializeFlowFile(flowToFile(base));
  assert.ok(!/runtime|shadow_of|boxed_connector/.test(plain), plain);

  const live = new Types.ObjectId();
  const shadow = {
    ...base,
    connectorRuntime: "boxed",
    boxedConnector: "close-v2",
    shadowOf: live,
    boxedApproval: { by: "owner_1", at: new Date(), slug: "close-v2" },
  } as unknown as IFlow;
  const text = serializeFlowFile(flowToFile(shadow));
  assert.ok(
    !/approval|owner_1/.test(text),
    "the approval is never in the file",
  );
  assert.match(text, /^runtime: boxed$/m);
  assert.match(text, /^boxed_connector: close-v2$/m);
  assert.match(text, new RegExp(`^shadow_of: '?${live}'?$`, "m"));
  const parsed = parseFlowFileResult(text);
  assert.ok(parsed.ok);
  if (parsed.ok) {
    assert.equal(parsed.file.runtime, "boxed");
    assert.equal(parsed.file.boxedConnector, "close-v2");
    assert.equal(parsed.file.shadowOf, String(live));
    const doc = new Flow({
      workspaceId: base.workspaceId,
      createdBy: "u",
    }) as unknown as IFlow;
    assert.equal(applyDefinition(doc, parsed.file), null);
    assert.equal(doc.connectorRuntime, "boxed");
    assert.equal(String(doc.shadowOf), String(live));
    // A file that drops `runtime:` switches the row back to built-in.
    const back = parseFlowFileResult(plain);
    assert.ok(back.ok);
    if (back.ok) {
      applyDefinition(doc, back.file);
      assert.equal(doc.connectorRuntime, undefined);
      assert.equal(doc.shadowOf, undefined);
    }
  }
  const bad = (extra: string) =>
    parseFlowFileResult(`${plain}${extra}\n`) as {
      ok: boolean;
      reason?: string;
    };
  assert.match(bad("runtime: sandbox").reason ?? "", /runtime/);
  assert.match(bad("shadow_of: pl-close").reason ?? "", /shadow_of/);
  assert.match(bad("boxed_connector: ../x").reason ?? "", /boxed_connector/);
  assert.equal(bad("runtime: builtin").ok, true);
}

// 5. The parity SQL: reads only, both datasets, every common column.
{
  const cols = comparableColumns(
    [
      "id",
      "name",
      "_mako_source_ts",
      "_syncedAt",
      "_mako_ingest_seq",
      "only_live",
    ],
    [
      "id",
      "name",
      "_mako_source_ts",
      "_syncedAt",
      "_mako_deleted_at",
      "only_shadow",
    ],
  );
  assert.deepEqual(cols, {
    common: ["_mako_source_ts", "id", "name"],
    liveOnly: ["only_live"],
    shadowOnly: ["only_shadow"],
  });
  const tables = {
    live: "`p`.`pl_close`.`leads`",
    shadow: "`p`.`pl_close_shadow`.`leads`",
    keyColumns: ["id"],
    columns: cols.common,
    cutoff: new Date("2026-11-17T11:50:00Z"),
    windowStart: new Date("2026-11-17T09:50:00Z"),
  };
  const sql = buildSummarySql(tables);
  assert.match(sql, /^WITH /);
  assert.ok(sql.includes("`p`.`pl_close`.`leads`"));
  assert.ok(sql.includes("`p`.`pl_close_shadow`.`leads`"));
  assert.ok(sql.includes("FULL OUTER JOIN"));
  assert.ok(sql.includes("TIMESTAMP('2026-11-17T11:50:00.000Z')"));
  assert.ok(sql.includes("TIMESTAMP('2026-11-17T09:50:00.000Z')"));
  assert.ok(sql.includes("AS d2"), "one count per column");
  assert.ok(
    sql.includes("COUNTIF(NOT recent AND lp AND lts >="),
    "the window leaves out keys in flight, as the full comparison does",
  );
  assert.ok(!/\b(INSERT|UPDATE|DELETE|MERGE|CREATE|DROP)\b/.test(sql));
  const samples = buildSamplesSql(tables, ["name", "it's"], 3);
  assert.ok(samples.includes("'it\\'s' AS field"));
  assert.ok(samples.includes("LIMIT 3"));
  assert.match(
    buildColumnsSql("p", "pl_close", ["leads", "contacts"]),
    /`p`\.`pl_close`\.INFORMATION_SCHEMA\.COLUMNS[\s\S]*IN \('leads', 'contacts'\)/,
  );

  const row = readSummaryRow(
    {
      live_rows: "100",
      shadow_rows: { value: "99" },
      compared: 98,
      live_only: 1,
      rows_differing: 2,
      live_checksum: "-12",
      w_live: 10,
      w_matched: 8,
      w_lag_p95: null,
      d0: 0,
      d1: 1,
      d2: 2,
    },
    cols.common,
  );
  assert.equal(row.shadowRows, 99);
  assert.equal(row.liveChecksum, "-12");
  assert.equal(row.window.missingOrBehind, 2);
  assert.equal(row.window.lagP95Seconds, null);
  assert.deepEqual(row.fieldDiffs, [
    { field: "name", rows: 2 },
    { field: "id", rows: 1 },
  ]);
}

// 6. The gate's arithmetic: cutoff, window, and per-entity reasons.
{
  const now = new Date("2026-11-17T12:00:00Z");
  const shadowStart = new Date("2026-11-17T11:45:00Z");
  assert.equal(
    parityCutoff({
      now,
      shadowLastStart: shadowStart,
      liveLastStart: null,
      liveOnWebhooks: true,
    }).toISOString(),
    "2026-11-17T11:35:00.000Z",
  );
  assert.equal(
    parityCutoff({
      now,
      shadowLastStart: shadowStart,
      liveLastStart: new Date("2026-11-17T11:00:00Z"),
      liveOnWebhooks: false,
    }).toISOString(),
    "2026-11-17T10:50:00.000Z",
    "a polled live flow bounds the cutoff too",
  );
  const cutoff = new Date("2026-11-17T12:00:00Z");
  assert.equal(
    parityWindow(cutoff, new Date("2026-11-17T09:00:00Z")).coverageMinutes,
    120,
  );
  assert.equal(
    parityWindow(cutoff, new Date("2026-11-17T11:15:00Z")).coverageMinutes,
    45,
  );
  assert.equal(
    parityWindow(cutoff, null).coverageMinutes,
    0,
    "no backfill, no window",
  );

  const clean = {
    entity: "leads",
    table: "leads",
    keyColumns: ["id"],
    liveRows: 10,
    shadowRows: 10,
    recent: 0,
    compared: 10,
    bothKeys: 10,
    liveOnly: 0,
    shadowOnly: 0,
    rowsDiffering: 0,
    liveChecksum: "1",
    shadowChecksum: "1",
    liveOnlyColumns: [],
    shadowOnlyColumns: [],
    topFields: [],
    window: {
      liveRows: 5,
      matched: 5,
      missingOrBehind: 0,
      lagP50Seconds: 10,
      lagP95Seconds: 60,
    },
  };
  assert.deepEqual(entityReasons(clean), []);
  assert.match(
    entityReasons({ ...clean, shadowOnly: 1 })[0],
    /1 of 10 rows differ/,
  );
  assert.match(
    entityReasons({ ...clean, liveOnlyColumns: ["x"] })[0],
    /columns differ/,
  );
  assert.match(
    entityReasons({
      ...clean,
      window: { ...clean.window, matched: 4, missingOrBehind: 1 },
    })[0],
    /1 of 5 live updates/,
  );
  assert.match(
    entityReasons({
      ...clean,
      window: { ...clean.window, lagP95Seconds: 3600 },
    })[0],
    /lag p95 is 3600 s/,
  );
  assert.deepEqual(entityReasons({ ...clean, error: "table missing" }), [
    "leads: table missing",
  ]);
}

console.info("boxed-runtime: ok");
