/**
 * DB-source chunk paging (db-sync-pagination.ts) against a real SQL engine
 * (node:sqlite, in memory). A plain query (no placeholders) is translated to
 * template mode: no row is lost when the incremental watermark or the keyset
 * column has ties, offset pages have a total order, and a numeric-looking
 * string cursor stays a string. A template query is substituted as written,
 * through the same entry point.
 *
 * The loop below mirrors executeDbSyncChunk: build the chunk query, run it,
 * upsert the rows into the "destination" by key, advance the cursor.
 *
 * Run: npx tsx src/services/db-sync-pagination.test.ts
 */
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

import {
  buildChunkQuery,
  cursorLiteral,
  isTemplateQuery,
  keysetCursorAfter,
  maxTrackingValue,
  plainQueryAsTemplate,
  type ChunkQueryInput,
  type ChunkCursorState,
} from "./db-sync-pagination";

type Row = Record<string, unknown>;

function makeDb(
  rows: Array<{ id: number; updated_at: string; code?: string }>,
) {
  const db = new DatabaseSync(":memory:");
  db.exec(
    "CREATE TABLE items (id INTEGER PRIMARY KEY, updated_at TEXT NOT NULL, code TEXT)",
  );
  const insert = db.prepare(
    "INSERT INTO items (id, updated_at, code) VALUES (?, ?, ?)",
  );
  for (const row of rows) insert.run(row.id, row.updated_at, row.code ?? null);
  return { db, insert };
}

/** Run one sync to completion; returns the rows seen and the watermark. */
function runSync(
  db: DatabaseSync,
  options: Omit<ChunkQueryInput, "state" | "sourceQuery"> & {
    sourceQuery?: string;
  },
  destination: Map<unknown, Row>,
): { pages: number; maxTracking?: string } {
  let state: ChunkCursorState = { offset: 0 };
  let maxTracking: string | undefined;
  for (let pages = 1; pages < 1000; pages++) {
    const query = buildChunkQuery({
      sourceQuery: options.sourceQuery ?? "SELECT * FROM items",
      ...options,
      state,
    });
    const rows = db.prepare(query).all() as Row[];
    for (const row of rows) destination.set(row.id, row); // upsert by key
    if (options.incrementalConfig?.trackingColumn) {
      maxTracking = maxTrackingValue(
        rows,
        options.incrementalConfig.trackingColumn,
        maxTracking,
      );
    }
    if (options.paginationMode === "keyset" && options.keysetColumn) {
      const cursor =
        rows.length > 0
          ? keysetCursorAfter(
              rows[rows.length - 1],
              options.keysetColumn,
              options.keyColumns,
            )
          : null;
      state = { ...state, ...(cursor ?? {}) };
    } else {
      state = { ...state, offset: state.offset + rows.length };
    }
    if (rows.length < options.maxRowsPerChunk) return { pages, maxTracking };
  }
  throw new Error("paging did not terminate");
}

const T1 = "2026-11-01T00:00:00.000Z";
const T2 = "2026-11-02T00:00:00.000Z";
const T3 = "2026-11-03T00:00:00.000Z";

function keysetTiesAcrossPageBoundaries(): void {
  // 10 rows, 7 of them on one timestamp: every 3-row page boundary falls
  // inside the tie.
  const seed = [
    { id: 1, updated_at: T1 },
    { id: 2, updated_at: T2 },
    ...[3, 4, 5, 6, 7, 8, 9].map(id => ({ id, updated_at: T3 })),
    { id: 10, updated_at: "2026-11-04T00:00:00.000Z" },
  ];
  for (const keysetDirection of ["asc", "desc"] as const) {
    const { db } = makeDb(seed);
    const seen = new Map<unknown, Row>();
    runSync(
      db,
      {
        syncMode: "full",
        paginationMode: "keyset",
        keysetColumn: "updated_at",
        keysetDirection,
        keyColumns: ["id"],
        maxRowsPerChunk: 3,
      },
      seen,
    );
    assert.deepEqual(
      [...seen.keys()].sort((a, b) => Number(a) - Number(b)),
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
      `keyset ${keysetDirection} lost tied rows`,
    );
  }

  // Without a key column there is no tiebreaker: this is the old loss,
  // kept here so the test proves the scenario actually exercises it.
  const { db } = makeDb(seed);
  const lossy = new Map<unknown, Row>();
  runSync(
    db,
    {
      syncMode: "full",
      paginationMode: "keyset",
      keysetColumn: "updated_at",
      keysetDirection: "asc",
      maxRowsPerChunk: 3,
    },
    lossy,
  );
  assert.ok(lossy.size < 10, "scenario must lose rows without a tiebreaker");
}

function incrementalTieWithLateCommit(): void {
  const { db, insert } = makeDb([
    { id: 1, updated_at: T1 },
    { id: 2, updated_at: T2 },
    { id: 3, updated_at: T3 },
  ]);
  const destination = new Map<unknown, Row>();
  const base = {
    syncMode: "incremental" as const,
    paginationMode: "offset" as const,
    keysetDirection: "asc" as const,
    keyColumns: ["id"],
    maxRowsPerChunk: 2,
  };
  const first = runSync(
    db,
    {
      ...base,
      incrementalConfig: {
        trackingColumn: "updated_at",
        trackingType: "timestamp",
      },
    },
    destination,
  );
  assert.equal(first.maxTracking, T3);
  assert.equal(destination.size, 3);

  // A row committed after the run, with the SAME timestamp as the
  // watermark (e.g. a long transaction that started earlier).
  insert.run(4, T3, null);
  runSync(
    db,
    {
      ...base,
      incrementalConfig: {
        trackingColumn: "updated_at",
        trackingType: "timestamp",
        lastValue: first.maxTracking,
      },
    },
    destination,
  );
  assert.ok(destination.has(4), "late row tied with the watermark was lost");
  assert.equal(destination.size, 4, "re-read tied rows are deduped by key");

  // Append (no key columns) keeps `>`: re-reading would duplicate.
  const appendQuery = buildChunkQuery({
    ...base,
    keyColumns: [],
    sourceQuery: "SELECT * FROM items",
    incrementalConfig: {
      trackingColumn: "updated_at",
      trackingType: "timestamp",
      lastValue: T3,
    },
    state: { offset: 0 },
  });
  assert.match(appendQuery, /updated_at > '2026-11-03T00:00:00.000Z'/);
}

function offsetOrderIsTotal(): void {
  const withKeys = buildChunkQuery({
    sourceQuery: "SELECT * FROM items;",
    syncMode: "incremental",
    incrementalConfig: { trackingColumn: "updated_at" },
    paginationMode: "offset",
    keysetDirection: "asc",
    keyColumns: ["id"],
    maxRowsPerChunk: 100,
    state: { offset: 200 },
  });
  assert.match(withKeys, /ORDER BY updated_at, id\s+LIMIT 100 OFFSET 200$/);

  const fullWithKeys = buildChunkQuery({
    sourceQuery: "SELECT * FROM items",
    syncMode: "full",
    paginationMode: "offset",
    keysetDirection: "asc",
    keyColumns: ["tenant", "id"],
    maxRowsPerChunk: 10,
    state: { offset: 0 },
  });
  assert.match(fullWithKeys, /ORDER BY tenant, id\s+LIMIT 10 OFFSET 0$/);

  // A user's own ORDER BY is respected.
  const own = buildChunkQuery({
    sourceQuery: "SELECT * FROM items ORDER BY code DESC",
    syncMode: "full",
    paginationMode: "offset",
    keysetDirection: "asc",
    keyColumns: ["id"],
    maxRowsPerChunk: 10,
    state: { offset: 0 },
  });
  assert.doesNotMatch(own, /ORDER BY tenant|ORDER BY id/);
}

function numericLookingStringCursorStaysString(): void {
  assert.equal(cursorLiteral("00123", "string"), "'00123'");
  assert.equal(cursorLiteral("123", "number"), "123");
  // Untyped state (written before types were recorded): old heuristic.
  assert.equal(cursorLiteral("123"), "123");
  assert.equal(cursorLiteral("it's"), "'it''s'");

  const cursor = keysetCursorAfter({ code: "00123", id: 7 }, "code", ["id"]);
  assert.deepEqual(cursor, {
    lastKeysetValue: "00123",
    lastKeysetValueType: "string",
    lastKeysetTiebreaker: [{ column: "id", value: "7", type: "number" }],
  });

  // String-ordered codes: as numbers "0013" < "00124", as strings it is >.
  const { db } = makeDb([
    { id: 1, updated_at: T1, code: "00123" },
    { id: 2, updated_at: T1, code: "00124" },
    { id: 3, updated_at: T1, code: "0013" },
  ]);
  const seen = new Map<unknown, Row>();
  runSync(
    db,
    {
      syncMode: "full",
      paginationMode: "keyset",
      keysetColumn: "code",
      keysetDirection: "asc",
      keyColumns: ["id"],
      maxRowsPerChunk: 1,
    },
    seen,
  );
  assert.equal(seen.size, 3);
}

function maxTrackingIgnoresRowOrder(): void {
  assert.equal(
    maxTrackingValue(
      [{ t: T2 }, { t: T3 }, { t: T1 }, { t: null }],
      "t",
      undefined,
    ),
    T3,
  );
  assert.equal(maxTrackingValue([{ t: T1 }], "t", T2), T2);
  assert.equal(maxTrackingValue([{ n: 9 }, { n: 10 }], "n"), "10");
}

function plainQueryIsTranslatedToTemplateMode(): void {
  const input: ChunkQueryInput = {
    sourceQuery: "SELECT * FROM items",
    syncMode: "full",
    paginationMode: "offset",
    keysetDirection: "asc",
    keyColumns: ["id"],
    maxRowsPerChunk: 50,
    state: { offset: 100 },
  };
  assert.equal(isTemplateQuery(input.sourceQuery), false);
  const template = plainQueryAsTemplate(input);
  assert.match(
    template,
    /ORDER BY id LIMIT \{\{limit\}\} OFFSET \{\{offset\}\}$/,
  );
  assert.ok(isTemplateQuery(template), "the translation is a template query");
  assert.equal(
    buildChunkQuery(input),
    "SELECT * FROM items ORDER BY id LIMIT 50 OFFSET 100",
  );

  const keyset = plainQueryAsTemplate({
    ...input,
    paginationMode: "keyset",
    keysetColumn: "code",
  });
  assert.match(keyset, /ORDER BY code ASC, id ASC LIMIT \{\{limit\}\}$/);
}

function templateQueryIsSubstituted(): void {
  const base = {
    syncMode: "incremental" as const,
    incrementalConfig: {
      trackingColumn: "updated_at",
      trackingType: "timestamp",
      lastValue: T2,
    },
    paginationMode: "offset" as const,
    keysetDirection: "asc" as const,
    keyColumns: ["id"],
    maxRowsPerChunk: 2,
  };
  const offsetTemplate =
    "SELECT * FROM items WHERE updated_at > '{{last_sync_value}}' ORDER BY id LIMIT {{limit}} OFFSET {{ offset }}";
  assert.equal(
    buildChunkQuery({
      ...base,
      sourceQuery: offsetTemplate,
      state: { offset: 4 },
    }),
    `SELECT * FROM items WHERE updated_at > '${T2}' ORDER BY id LIMIT 2 OFFSET 4`,
    "placeholders substituted, nothing appended",
  );

  // Keyset: a string cursor stays a string, a numeric one is bare.
  const keysetTemplate =
    "SELECT * FROM items WHERE code > {{keyset_value}} ORDER BY code LIMIT {{limit}}";
  const keysetInput = {
    ...base,
    syncMode: "full" as const,
    paginationMode: "keyset" as const,
    keysetColumn: "code",
    sourceQuery: keysetTemplate,
  };
  assert.equal(
    buildChunkQuery({
      ...keysetInput,
      state: {
        offset: 0,
        lastKeysetValue: "00123",
        lastKeysetValueType: "string",
      },
    }),
    "SELECT * FROM items WHERE code > 00123 ORDER BY code LIMIT 2",
  );
  assert.equal(
    buildChunkQuery({
      ...keysetInput,
      state: { offset: 0 },
      savedKeysetValue: "41",
    }),
    "SELECT * FROM items WHERE code > 41 ORDER BY code LIMIT 2",
  );

  // Against the engine: a template query pages to completion.
  const { db } = makeDb([
    { id: 1, updated_at: T1 },
    { id: 2, updated_at: T2 },
    { id: 3, updated_at: T3 },
    { id: 4, updated_at: T3 },
    { id: 5, updated_at: T3 },
  ]);
  const seen = new Map<unknown, Row>();
  let state: ChunkCursorState = { offset: 0 };
  for (let page = 0; page < 10; page++) {
    const rows = db
      .prepare(buildChunkQuery({ ...base, sourceQuery: offsetTemplate, state }))
      .all() as Row[];
    for (const row of rows) seen.set(row.id, row);
    state = { offset: state.offset + rows.length };
    if (rows.length < base.maxRowsPerChunk) break;
  }
  assert.deepEqual([...seen.keys()], [3, 4, 5]);
}

plainQueryIsTranslatedToTemplateMode();
templateQueryIsSubstituted();
keysetTiesAcrossPageBoundaries();
incrementalTieWithLateCommit();
offsetOrderIsTotal();
numericLookingStringCursorStaysString();
maxTrackingIgnoresRowOrder();
console.info("db-sync-pagination tests passed");
