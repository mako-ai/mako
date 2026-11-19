import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { promises as fs } from "fs";
import { DuckDBInstance } from "@duckdb/node-api";
import { MongoClient, type Collection } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import { Types } from "mongoose";
import {
  MAKO_SYSTEM_FIELDS,
  type ConnectorEntitySchema,
} from "../../connectors/base/BaseConnector";
import {
  normalizePayloadBySchema,
  selectLatestChangePerRecord,
} from "../normalization";
import {
  ABSENT_COLUMNS_FIELD,
  collectAbsentColumns,
  groupRowsByKeySet,
  markAbsentColumns,
  withPolledDeleteState,
  writeBatchByKeySet,
} from "../sparse-rows";
import { buildCdcParquet } from "./bigquery-load";
import {
  buildCreateLiveTableStatement,
  buildMergeStatement,
  buildStagingAbsentColumnsQuery,
  liveTableCreateColumns,
} from "./bigquery-sql";
import { MongoDbDestinationAdapter } from "./mongodb";
import type { CdcEntityLayout } from "./registry";

/**
 * PT Close, 17 Nov 2026: after the switch to the boxed Close connector, the
 * backfill NULLed lead.source on 92 of 94 rows and
 * meeting.calendar_event_link on 23 of 23. Close's Search and GET never
 * return these fields; only webhooks carry them. Every CDC writer must
 * leave a column alone when a record lacks its key, and clear it when the
 * record carries the key as null.
 */

const schema: ConnectorEntitySchema = {
  entity: "leads",
  keyColumns: ["id"],
  fields: {
    id: { type: "string", nullable: false },
    name: { type: "string", nullable: true },
    source: { type: "string", nullable: true },
    calendar_event_link: { type: "string", nullable: true },
    _syncedAt: { type: "timestamp", nullable: false },
    _mako_source_ts: { type: "timestamp", nullable: false },
    is_deleted: { type: "boolean", nullable: false, defaultValue: false },
  },
} as unknown as ConnectorEntitySchema;

async function readParquet(filePath: string) {
  const instance = await DuckDBInstance.create(":memory:");
  const conn = await instance.connect();
  try {
    const p = filePath.replace(/'/g, "''");
    const cols = (
      await conn.runAndReadAll(`SELECT name FROM parquet_schema('${p}')`)
    )
      .getRowObjects()
      .map(r => String(r.name));
    const rows = (
      await conn.runAndReadAll(`SELECT * FROM read_parquet('${p}') ORDER BY id`)
    ).getRowObjects();
    return { cols, rows };
  } finally {
    conn.closeSync();
    instance.closeSync();
  }
}

const ts = new Date("2026-11-17T10:00:00Z");
const row = (r: Record<string, unknown>) => ({
  _syncedAt: ts,
  _mako_source_ts: ts,
  ...r,
});

describe("BigQuery staging: sparse columns", () => {
  it("stages only the columns some record carries, and marks the rows that lack one", async () => {
    const parquet = await buildCdcParquet(
      "leads",
      [
        row({ id: "a", name: "A", source: "webhook" }),
        // A poll row: Close Search returns no `source` key.
        row({ id: "b", name: "B" }),
        // An explicit null is a real null: it stays a value, not an absence.
        row({ id: "c", name: "C", source: null }),
        // undefined is an absent key, as JSON makes it at the box boundary.
        row({ id: "d", name: "D", source: undefined }),
      ],
      schema,
    );
    try {
      const { cols, rows } = await readParquet(parquet.filePath);
      // No record carries calendar_event_link: it stays out of staging, so
      // the MERGE cannot touch it.
      expect(cols).not.toContain("calendar_event_link");
      expect(cols).toContain("source");
      expect(cols).toContain(ABSENT_COLUMNS_FIELD);
      const marker = Object.fromEntries(
        rows.map(r => [r.id, r[ABSENT_COLUMNS_FIELD]]),
      );
      expect(marker).toEqual({
        a: null,
        b: ",source,",
        c: null,
        d: ",source,",
      });
    } finally {
      await fs.rm(parquet.filePath, { force: true });
    }
  });

  it("keeps a column whose values are all null when the key is present", async () => {
    const parquet = await buildCdcParquet(
      "leads",
      [row({ id: "a", source: null }), row({ id: "b", source: null })],
      schema,
    );
    try {
      const { cols } = await readParquet(parquet.filePath);
      expect(cols).toContain("source");
      // Every row carries every staged column: no marker, same shape as before.
      expect(cols).not.toContain(ABSENT_COLUMNS_FIELD);
    } finally {
      await fs.rm(parquet.filePath, { force: true });
    }
  });

  it("the MERGE keeps the live value of a column the staging row lacks", () => {
    const sql = buildMergeStatement({
      fullLive: "`p`.`d`.`leads`",
      fullStaging: "`p`.`d`.`leads_stg`",
      columns: ["id", "name", "source", "_mako_source_ts"],
      keyColumns: ["id"],
      stagingCols: new Set([
        "id",
        "name",
        "source",
        "_mako_source_ts",
        ABSENT_COLUMNS_FIELD,
      ]),
      liveTypes: new Map([
        ["id", "STRING"],
        ["name", "STRING"],
        ["source", "STRING"],
        ["_mako_source_ts", "TIMESTAMP"],
      ]),
      entitySchema: schema,
    });
    expect(sql).toContain(
      "`source` = IF(STRPOS(IFNULL(__stg.`_mako_absent_cols`, ''), ',source,') > 0, __live.`source`, __stg.`source`)",
    );
    expect(sql).toContain("`_mako_absent_cols` FROM `p`.`d`.`leads_stg`");
    // The marker steers the MERGE; it never reaches the live table.
    expect(sql).toMatch(
      /INSERT \(`id`, `name`, `source`, `_mako_source_ts`\) VALUES/,
    );
    expect(sql).not.toMatch(/`_mako_absent_cols` = /);
  });

  it("without a marker the MERGE is unchanged", () => {
    const sql = buildMergeStatement({
      fullLive: "`p`.`d`.`leads`",
      fullStaging: "`p`.`d`.`leads_stg`",
      columns: ["id", "source"],
      keyColumns: ["id"],
      stagingCols: new Set(["id", "source"]),
      liveTypes: new Map([
        ["id", "STRING"],
        ["source", "STRING"],
      ]),
    });
    expect(sql).toContain("UPDATE SET `source` = __stg.`source`");
    expect(sql).not.toContain("STRPOS");
  });

  it("the bulk flush marks the schema columns a buffered row lacks", () => {
    const marked = markAbsentColumns(
      [
        { id: "a", name: "A" },
        { id: "b", name: "B", source: null },
      ],
      ["id", "name", "source", "calendar_event_link"],
    );
    expect(marked[0][ABSENT_COLUMNS_FIELD]).toBe(
      ",source,calendar_event_link,",
    );
    expect(marked[1][ABSENT_COLUMNS_FIELD]).toBe(",calendar_event_link,");
  });
});

/**
 * realadvisor-prod, 17-19 Nov 2026: CDC bytes went from 0.7-1.2 TiB a day to
 * 20 TiB after #1347. Its MERGE wrote `IF(absent, __live.col, __stg.col)` for
 * every column, and BigQuery bills a MERGE for every live column it names.
 * ES email_activities went from 0.3 GiB to 16 GiB per MERGE. The MERGE now
 * names on live only the keys, the guard columns, and the columns some row
 * of the batch lacks.
 */
describe("BigQuery MERGE: live columns read", () => {
  const dataCols = Array.from({ length: 12 }, (_, i) => `col_${i}`);
  const columns = [
    "id",
    ...dataCols,
    "_mako_source_ts",
    "_mako_deleted_at",
    "_syncedAt",
    "date_created",
  ];
  const liveTypes = new Map(
    columns.map(c => [
      c,
      c === "_mako_source_ts" ||
      c === "_mako_deleted_at" ||
      c === "_syncedAt" ||
      c === "date_created"
        ? "TIMESTAMP"
        : "STRING",
    ]),
  );
  const merge = (
    absentColumns: ReadonlySet<string> | undefined,
    extra: { fullRead?: boolean; marker?: boolean } = {},
  ) =>
    buildMergeStatement({
      fullLive: "`p`.`d`.`email_activities`",
      fullStaging: "`p`.`d`.`email_activities_stg`",
      columns,
      keyColumns: ["id"],
      stagingCols: new Set([
        ...columns,
        ...(extra.marker === false ? [] : [ABSENT_COLUMNS_FIELD]),
      ]),
      liveTypes,
      livePartitionFilter:
        "__live.`date_created` >= TIMESTAMP '2026-11-01 00:00:00 UTC'",
      fullRead: extra.fullRead,
      absentColumns,
    });
  const liveRefs = (sql: string) =>
    [...new Set([...sql.matchAll(/__live\.`([^`]+)`/g)].map(m => m[1]))].sort();

  it("a batch with no absent column reads only the key, the guard and the partition column", () => {
    const sql = merge(new Set());
    expect(liveRefs(sql)).toEqual(["_mako_source_ts", "date_created", "id"]);
    expect(sql).not.toContain("STRPOS");
    expect(sql).not.toContain(ABSENT_COLUMNS_FIELD);
    // Byte-identical to the statement for an unmarked staging table.
    expect(sql).toBe(merge(undefined, { marker: false }));
  });

  it("a batch with 2 absent columns reads those 2 and nothing else", () => {
    const sql = merge(new Set(["col_3", "col_7"]));
    expect(liveRefs(sql)).toEqual([
      "_mako_source_ts",
      "col_3",
      "col_7",
      "date_created",
      "id",
    ]);
    expect(sql).toContain(
      "`col_3` = IF(STRPOS(IFNULL(__stg.`_mako_absent_cols`, ''), ',col_3,') > 0, __live.`col_3`, __stg.`col_3`)",
    );
    expect(sql).toContain("`col_4` = __stg.`col_4`");
    expect(sql).toContain(
      "`_mako_absent_cols` FROM `p`.`d`.`email_activities_stg`",
    );
  });

  it("a full read adds only the delete stamp the guard needs", () => {
    expect(liveRefs(merge(new Set(["col_3"]), { fullRead: true }))).toEqual([
      "_mako_deleted_at",
      "_mako_source_ts",
      "col_3",
      "date_created",
      "id",
    ]);
  });

  it("an absent key column never reads live; it is the join", () => {
    const sql = merge(new Set(["id"]));
    expect(sql).not.toContain("STRPOS");
  });

  it("an unknown absent set keeps every staged column guarded (fallback)", () => {
    const sql = merge(undefined);
    for (const c of dataCols) expect(liveRefs(sql)).toContain(c);
  });

  it("prepareSparseBatch names exactly the columns some row lacks", async () => {
    const parquet = await buildCdcParquet(
      "leads",
      [
        row({ id: "a", name: "A", source: "web" }),
        row({ id: "b", name: "B" }),
        row({ id: "c", calendar_event_link: null }),
      ],
      schema,
    );
    try {
      expect([...parquet.absentColumns].sort()).toEqual([
        "calendar_event_link",
        "name",
        "source",
      ]);
    } finally {
      await fs.rm(parquet.filePath, { force: true });
    }
    expect(
      collectAbsentColumns([
        { id: "a" },
        { id: "b", [ABSENT_COLUMNS_FIELD]: ",x,y," },
        { id: "c", [ABSENT_COLUMNS_FIELD]: ",y,z," },
      ]),
    ).toEqual(new Set(["x", "y", "z"]));
  });

  it("the bulk flush reads the absent set from the marker column of staging", () => {
    expect(buildStagingAbsentColumnsQuery("`p`.`d`.`s`")).toBe(
      "SELECT DISTINCT c FROM `p`.`d`.`s`, UNNEST(SPLIT(`_mako_absent_cols`, ',')) AS c WHERE `_mako_absent_cols` IS NOT NULL AND c != ''",
    );
  });
});

describe("normalization: absent keys stay absent", () => {
  it("normalizePayloadBySchema drops undefined keys, keeps nulls, and adds no schema key except defaults", () => {
    const { payload } = normalizePayloadBySchema(
      { id: "a", source: undefined, name: null },
      schema,
    );
    expect(payload).toEqual({ id: "a", name: null, is_deleted: false });
    expect("source" in payload).toBe(false);
    expect("calendar_event_link" in payload).toBe(false);
  });

  it("a later poll upsert in the same batch keeps the webhook's field", () => {
    const [latest] = selectLatestChangePerRecord([
      {
        recordId: "a",
        sourceTs: "2026-11-17T10:00:00Z",
        ingestSeq: 1,
        operation: "upsert",
        payload: { id: "a", name: "A", source: "webhook" },
      },
      {
        recordId: "a",
        sourceTs: "2026-11-17T10:00:00Z",
        ingestSeq: 2,
        operation: "upsert",
        payload: { id: "a", name: "A2" },
      },
    ]);
    expect(latest.ingestSeq).toBe(2);
    expect(latest.payload).toEqual({ id: "a", name: "A2", source: "webhook" });
  });

  it("an explicit null in the latest upsert clears the field", () => {
    const [latest] = selectLatestChangePerRecord([
      {
        recordId: "a",
        sourceTs: "2026-11-17T10:00:00Z",
        ingestSeq: 1,
        operation: "upsert",
        payload: { id: "a", source: "webhook" },
      },
      {
        recordId: "a",
        sourceTs: "2026-11-17T11:00:00Z",
        ingestSeq: 2,
        operation: "upsert",
        payload: { id: "a", source: null },
      },
    ]);
    expect(latest.payload).toEqual({ id: "a", source: null });
  });

  it("a delete between upserts stops the fill", () => {
    const [latest] = selectLatestChangePerRecord([
      {
        recordId: "a",
        sourceTs: "2026-11-17T10:00:00Z",
        ingestSeq: 1,
        operation: "upsert",
        payload: { id: "a", source: "webhook" },
      },
      {
        recordId: "a",
        sourceTs: "2026-11-17T10:00:00Z",
        ingestSeq: 2,
        operation: "delete",
        payload: null,
      },
      {
        recordId: "a",
        sourceTs: "2026-11-17T10:00:00Z",
        ingestSeq: 3,
        operation: "upsert",
        payload: { id: "a", name: "new" },
      },
    ]);
    expect(latest.payload).toEqual({ id: "a", name: "new" });
  });
});

describe("delete state on polled rows", () => {
  it("a polled row clears a stale soft delete instead of keeping it as absent", () => {
    // A webhook soft-deleted the record; a later backfill returns it live.
    // The orchestrator sets _mako_deleted_at: null on every polled record,
    // so deleted_at derives as null and neither is marked absent.
    const systemSchema = {
      ...schema,
      fields: { ...schema.fields, ...MAKO_SYSTEM_FIELDS },
    } as ConnectorEntitySchema;
    const { payload } = normalizePayloadBySchema(
      { id: "a", name: "A", _mako_deleted_at: null },
      systemSchema,
    );
    expect(payload).toMatchObject({
      _mako_deleted_at: null,
      deleted_at: null,
      is_deleted: false,
    });
    const [marked] = markAbsentColumns(
      [payload],
      Object.keys(systemSchema.fields),
    );
    const absent = String(marked[ABSENT_COLUMNS_FIELD] ?? "");
    for (const col of ["_mako_deleted_at", "deleted_at", "is_deleted"]) {
      expect(absent).not.toContain(`,${col},`);
    }
  });
});

describe("row writers: one column list per key set", () => {
  it("groups rows by key set, so a row never writes a column it lacks", async () => {
    const rows = [
      { id: "a", name: "A", source: "webhook" },
      { id: "b", name: "B" },
      { id: "c", name: "C", source: null },
      { id: "d", name: "D", source: undefined },
    ];
    expect(groupRowsByKeySet(rows).map(g => g.map(r => r.id))).toEqual([
      ["a", "c"],
      ["b", "d"],
    ]);

    const calls: string[][] = [];
    const result = await writeBatchByKeySet(
      {
        writeBatch: async (batch: Record<string, unknown>[]) => {
          // The SQL drivers build their column list from the batch's keys.
          const cols = new Set<string>();
          for (const r of batch) Object.keys(r).forEach(k => cols.add(k));
          calls.push([...cols]);
          return { success: true, rowsWritten: batch.length };
        },
      },
      rows,
      { keyColumns: ["id"] },
    );
    expect(result).toEqual({ success: true, rowsWritten: 4 });
    expect(calls).toEqual([
      ["id", "name", "source"],
      ["id", "name"],
    ]);
  });
});

describe("MongoDB CDC adapter: sparse rows against a real mongod", () => {
  let mongo: MongoMemoryServer;
  let client: MongoClient;
  let collection: Collection;
  let adapter: MongoDbDestinationAdapter;
  const layout = {
    entity: "leads",
    tableName: "leads",
    keyColumns: ["id"],
  } as unknown as CdcEntityLayout;
  const flow = { _id: new Types.ObjectId() } as never;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    client = await MongoClient.connect(mongo.getUri());
    collection = client.db("t").collection("leads");
    adapter = new MongoDbDestinationAdapter({} as never);
    const a = adapter as unknown as Record<string, unknown>;
    a.getCollection = async () => collection;
  });

  afterAll(async () => {
    await client?.close();
    await mongo?.stop();
  });

  const upsert = (seq: number, payload: Record<string, unknown>) => ({
    recordId: String(payload.id),
    sourceTs: new Date(Date.UTC(2026, 10, 17, 10, 0, seq)),
    ingestSeq: seq,
    operation: "upsert" as const,
    payload,
  });

  it("webhook then poll keeps the field; an explicit null clears it; mixed key sets in one batch", async () => {
    await adapter.applyEvents({
      events: [
        upsert(1, { id: "a", name: "A", source: "webhook" }),
        upsert(2, { id: "b", name: "B", source: "webhook" }),
      ] as never,
      layout,
      flow,
    });
    // One batch with mixed key sets: a lacks `source`, b carries null.
    await adapter.applyEvents({
      events: [
        upsert(3, { id: "a", name: "A2" }),
        upsert(4, { id: "b", name: "B2", source: null }),
      ] as never,
      layout,
      flow,
    });
    const docs = await collection
      .find({}, { projection: { _id: 0, id: 1, name: 1, source: 1 } })
      .sort({ id: 1 })
      .toArray();
    expect(docs).toEqual([
      { id: "a", name: "A2", source: "webhook" },
      { id: "b", name: "B2", source: null },
    ]);
  });
});

describe("follow-ups: new live tables and schemaless delete state", () => {
  it("a sparse first batch creates the live table with every schema field", () => {
    const partitioned = {
      ...schema,
      fields: {
        ...schema.fields,
        date_created: { type: "timestamp", nullable: true },
      },
    } as ConnectorEntitySchema;
    // The first batch carries neither date_created (the partition field)
    // nor calendar_event_link.
    const cols = liveTableCreateColumns(
      new Set([
        "id",
        "name",
        "_syncedAt",
        "_mako_source_ts",
        ABSENT_COLUMNS_FIELD,
      ]),
      partitioned,
    );
    expect(cols).toEqual(
      expect.arrayContaining(["date_created", "calendar_event_link", "source"]),
    );
    expect(cols).not.toContain(ABSENT_COLUMNS_FIELD);
    // A dotted schema name (Close custom fields) maps to the staged name.
    const dotted = liveTableCreateColumns(new Set(["id", "custom_cf_abc"]), {
      ...schema,
      fields: {
        ...schema.fields,
        "custom.cf_abc": { type: "string", nullable: true },
      },
    } as ConnectorEntitySchema);
    expect(dotted).toContain("custom_cf_abc");
    expect(dotted).not.toContain("custom.cf_abc");
    const ddl = buildCreateLiveTableStatement({
      fullLive: "`p`.`d`.`leads`",
      columns: cols,
      layout: {
        entity: "leads",
        tableName: "leads",
        keyColumns: ["id"],
        partitioning: { field: "date_created", granularity: "day" },
      } as unknown as CdcEntityLayout,
      entitySchema: partitioned,
    });
    expect(ddl).toContain("`date_created` TIMESTAMP");
    expect(ddl).toContain("PARTITION BY TIMESTAMP_TRUNC(`date_created`, DAY)");
  });

  it("a polled row carries all 3 delete columns, with or without a schema", () => {
    expect(withPolledDeleteState({ id: "a" })).toEqual({
      id: "a",
      _mako_deleted_at: null,
      deleted_at: null,
      is_deleted: false,
    });
    const when = new Date("2026-11-17T10:00:00Z");
    expect(withPolledDeleteState({ id: "b", _mako_deleted_at: when })).toEqual({
      id: "b",
      _mako_deleted_at: when,
      deleted_at: when,
      is_deleted: true,
    });
    // A source's own deleted_at / is_deleted wins.
    expect(
      withPolledDeleteState({ id: "c", deleted_at: when, is_deleted: true }),
    ).toMatchObject({
      _mako_deleted_at: null,
      deleted_at: when,
      is_deleted: true,
    });
  });
});
