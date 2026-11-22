import assert from "node:assert/strict";
import test from "node:test";
import {
  crashedEngineError,
  isOutOfMemoryError,
  retryDelayMs,
  mentionedBindings,
  missingBinding,
  quoteIdent,
  quoteString,
  readsCatalog,
  toPlainRows,
  toPlainRowsCooperative,
  isReadOnlySql,
  LARGE_QUERY_ROWS,
  largeQueryWarning,
} from "./data-core.js";

// apache-arrow is a devDependency (the version duckdb-wasm 1.29 bundles).
// The publish job runs `node --test` without an install: skip there.
let arrow = null;
try {
  arrow = await import("apache-arrow");
} catch {
  arrow = null;
}
const withArrow = { skip: arrow ? false : "apache-arrow not installed" };

// toPlainRows exactly as 2.7.3 shipped it: the golden reference. Every
// row the new decoder returns must deep-equal what this one returned.
function referenceToPlainRows(table, cap) {
  function columnDecoder(field) {
    const type = String(field.type);
    if (type.startsWith("Date")) {
      return v => (v == null ? v : new Date(Number(v)).toISOString().slice(0, 10));
    }
    if (type.startsWith("Timestamp")) {
      return v => (v == null ? v : new Date(Number(v)).toISOString());
    }
    return v =>
      typeof v === "bigint" && v >= Number.MIN_SAFE_INTEGER && v <= Number.MAX_SAFE_INTEGER
        ? Number(v)
        : v;
  }
  const rows = [];
  const fields = table.schema.fields.map(f => f.name);
  const decoders = table.schema.fields.map(columnDecoder);
  const limit = cap == null ? Infinity : cap;
  for (const row of table) {
    if (rows.length >= limit) break;
    const out = {};
    for (let i = 0; i < fields.length; i++) {
      out[fields[i]] = decoders[i](row[fields[i]]);
    }
    rows.push(out);
  }
  return { rows, fields };
}

// Nested Arrow values (List → Vector) carry lazily-filled caches, so two
// equal vectors need not be deepStrictEqual: compare their contents.
function canon(result) {
  const cell = v =>
    v instanceof arrow.Vector ? { vector: [...v].map(cell) } : v;
  return {
    fields: result.fields,
    rows: result.rows.map(r => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, cell(v)]))),
  };
}
const sameRows = (table, cap, msg) =>
  assert.deepStrictEqual(canon(toPlainRows(table, cap)), canon(referenceToPlainRows(table, cap)), msg);

function bitmap(valid) {
  const bytes = new Uint8Array(Math.ceil(valid.length / 8));
  valid.forEach((ok, i) => {
    if (ok) bytes[i >> 3] |= 1 << (i & 7);
  });
  return bytes;
}

function utf8(strings) {
  const enc = new TextEncoder();
  const parts = strings.map(s => (s == null ? new Uint8Array() : enc.encode(s)));
  const offsets = new Int32Array(parts.length + 1);
  parts.forEach((p, i) => (offsets[i + 1] = offsets[i] + p.length));
  const data = new Uint8Array(offsets[parts.length]);
  parts.forEach((p, i) => data.set(p, offsets[i]));
  const valid = strings.map(s => s != null);
  return arrow.makeData({
    type: new arrow.Utf8(),
    length: strings.length,
    nullCount: valid.filter(v => !v).length,
    nullBitmap: bitmap(valid),
    valueOffsets: offsets,
    data,
  });
}

function bigints(type, values) {
  const valid = values.map(v => v != null);
  return arrow.makeData({
    type,
    length: values.length,
    nullCount: valid.filter(v => !v).length,
    nullBitmap: bitmap(valid),
    data: BigInt64Array.from(values, v => (v == null ? 0n : v)),
  });
}

function int32s(type, values) {
  const valid = values.map(v => v != null);
  return arrow.makeData({
    type,
    length: values.length,
    nullCount: valid.filter(v => !v).length,
    nullBitmap: bitmap(valid),
    data: Int32Array.from(values, v => (v == null ? 0 : v)),
  });
}

function sampleTable() {
  const n = 6;
  const cols = {
    id: bigints(new arrow.Int64(), [1n, 2n, null, 2n ** 60n, -5n, 9007199254740991n]),
    name: utf8(["alpha", "", null, "Zürich", "b", "日本"]),
    ascii: utf8(["a", "bb", "ccc", "dddd", "", "f"]),
    code: utf8(["x", null, "y", null, "z", "w"]),
    day: int32s(new arrow.DateDay(), [19783, 0, null, -1, 2932896, 19783]),
    at_us: bigints(new arrow.TimestampMicrosecond(), [
      1709251200123456n,
      -1500n,
      null,
      0n,
      253402300799999999n, // 9999-12-31 23:59:59.999999: past 2^53, BigInt path
      1700000000123999n,
    ]),
    at_ms: bigints(new arrow.TimestampMillisecond(), [1709251200123n, null, 0n, -1n, 1n, 2n]),
    at_s: bigints(new arrow.TimestampSecond(), [1709251200n, 0n, null, -1n, 1n, 2n]),
    at_ns: bigints(new arrow.TimestampNanosecond(), [1709251200123456789n, null, -1n, 0n, 999999n, 1000000n]),
    at_tz: bigints(new arrow.TimestampMicrosecond("UTC"), [1n, 2n, 3n, null, 5n, 6n]),
  };
  const vectors = Object.fromEntries(Object.entries(cols).map(([k, d]) => [k, arrow.makeVector(d)]));
  const table = new arrow.Table(vectors);
  assert.equal(table.numRows, n);
  return table.assign(
    new arrow.Table({
      price: arrow.vectorFromArray([1.5, NaN, -0, 3, null, 5], new arrow.Float64()),
      rooms: arrow.vectorFromArray([1, 2, 3, 4, 5, 6], new arrow.Int32()),
      flag: arrow.vectorFromArray([true, false, null, true, false, true], new arrow.Bool()),
      tags: arrow.vectorFromArray(
        [[1], [], null, [2, 3], [4], [5]],
        new arrow.List(new arrow.Field("item", new arrow.Int32(), true)),
      ),
    }),
  );
}

test("golden: column-wise decode equals the 2.7.3 row decoder", withArrow, () => {
  const table = sampleTable();
  for (const cap of [undefined, null, Infinity, 0, 1, 3, 6, 100]) {
    sameRows(table, cap, "cap " + cap);
  }
});

test("golden: pinned normalizer output (apps.md §15.4)", withArrow, () => {
  const { rows } = toPlainRows(sampleTable());
  assert.deepStrictEqual(rows[0].day, "2024-03-01");
  assert.equal(rows[0].at_us, "2024-03-01T00:00:00.123Z");
  assert.equal(rows[1].at_us, "1969-12-31T23:59:59.999Z");
  assert.equal(rows[0].at_ms, "2024-03-01T00:00:00.123Z");
  assert.equal(rows[0].at_s, "2024-03-01T00:00:00.000Z");
  assert.equal(rows[0].at_ns, "2024-03-01T00:00:00.123Z");
  assert.equal(rows[2].at_us, null);
  assert.equal(rows[2].day, null);
  assert.equal(rows[0].id, 1);
  assert.equal(rows[3].id, 2n ** 60n); // unsafe: stays a BigInt
  assert.equal(rows[3].name, "Zürich");
  assert.equal(rows[1].code, null);
  assert.equal(rows[0].price, 1.5);
});

test("golden: multi-chunk, sliced and duplicate-name tables", withArrow, () => {
  const t = sampleTable();
  const chunked = t.concat(t, t);
  assert.equal(chunked.batches.length, 3);
  sameRows(chunked);
  sameRows(chunked, 8);
  const sliced = chunked.slice(2, 11);
  sameRows(sliced);
  // `select a, b as a`: a row proxy reads the FIRST "a" for both.
  const dupFields = [
    new arrow.Field("a", new arrow.Utf8(), true),
    new arrow.Field("a", new arrow.TimestampMicrosecond(), true),
  ];
  const dupBatch = new arrow.RecordBatch(
    new arrow.Schema(dupFields),
    arrow.makeData({
      type: new arrow.Struct(dupFields),
      length: 2,
      nullCount: 0,
      children: [utf8(["p", "q"]), bigints(new arrow.TimestampMicrosecond(), [1n, 2n])],
    }),
  );
  const dup = new arrow.Table([dupBatch]);
  assert.equal(dup.numCols, 2);
  // The string "p" read as a timestamp: 2.7.3 threw, and still does.
  assert.throws(() => referenceToPlainRows(dup), RangeError);
  assert.throws(() => toPlainRows(dup), RangeError);
  const sameType = [
    new arrow.Field("a", new arrow.Utf8(), true),
    new arrow.Field("a", new arrow.Int64(), true),
  ];
  const dup2 = new arrow.Table([
    new arrow.RecordBatch(
      new arrow.Schema(sameType),
      arrow.makeData({
        type: new arrow.Struct(sameType),
        length: 2,
        nullCount: 0,
        children: [utf8(["p", "q"]), bigints(new arrow.Int64(), [1n, 2n])],
      }),
    ),
  ]);
  sameRows(dup2);
  assert.deepStrictEqual(toPlainRows(dup2).rows, [{ a: "p" }, { a: "q" }]);
});

test("golden: a 20k-row random table", withArrow, () => {
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const n = 20000;
  const strs = Array.from({ length: n }, () => (rnd() < 0.1 ? null : "s" + Math.floor(rnd() * 1e6)));
  const ts = Array.from({ length: n }, () => (rnd() < 0.2 ? null : BigInt(Math.floor((rnd() - 0.3) * 4e15))));
  const days = Array.from({ length: n }, () => (rnd() < 0.1 ? null : Math.floor(rnd() * 40000) - 5000));
  const table = new arrow.Table({
    s: arrow.makeVector(utf8(strs)),
    t: arrow.makeVector(bigints(new arrow.TimestampMicrosecond(), ts)),
    d: arrow.makeVector(int32s(new arrow.DateDay(), days)),
  });
  sameRows(table);
});

test("cooperative rows match the synchronous converter for caps, slices and batches", withArrow, async () => {
  const table = sampleTable();
  for (const input of [table, table.concat(table, table), table.concat(table).slice(2, 11)]) {
    for (const cap of [undefined, null, 0, 1, 3, 8, Infinity]) {
      assert.deepStrictEqual(canon(await toPlainRowsCooperative(input, cap, { yieldTask: async () => {} })), canon(toPlainRows(input, cap)));
    }
  }
});

test("cooperative rows preserve duplicate field values and errors", withArrow, async () => {
  function duplicate(secondType, secondData) {
    const fields = [new arrow.Field("a", new arrow.Utf8(), true), new arrow.Field("a", secondType, true)];
    return new arrow.Table([new arrow.RecordBatch(new arrow.Schema(fields), arrow.makeData({
      type: new arrow.Struct(fields), length: 2, nullCount: 0,
      children: [utf8(["p", "q"]), secondData],
    }))]);
  }
  const table = duplicate(new arrow.Int64(), bigints(new arrow.Int64(), [1n, 2n]));
  assert.deepStrictEqual(await toPlainRowsCooperative(table), toPlainRows(table));
  const invalid = duplicate(new arrow.TimestampMicrosecond(), bigints(new arrow.TimestampMicrosecond(), [1n, 2n]));
  assert.throws(() => toPlainRows(invalid), RangeError);
  await assert.rejects(toPlainRowsCooperative(invalid), RangeError);
});

function advanceClock(t, step = 10) {
  const original = Object.getOwnPropertyDescriptor(globalThis, "performance");
  let ticks = 0;
  Object.defineProperty(globalThis, "performance", { configurable: true, value: { now: () => (ticks += step) } });
  t.after(() => Object.defineProperty(globalThis, "performance", original));
}

test("cooperative UTF-8 decoding yields within a large cell and preserves boundaries", withArrow, async t => {
  advanceClock(t);
  const text = "x".repeat(16383) + "😀" + "é".repeat(25000);
  const table = new arrow.Table({ value: arrow.makeVector(utf8(["prefix", text, null, "suffix"])) }).slice(1, 4);
  let yields = 0;
  const result = await toPlainRowsCooperative(table, undefined, { yieldTask: async () => { yields++; } });
  assert.ok(yields >= 4, `expected byte-bounded yields, got ${yields}`);
  assert.deepStrictEqual(result, toPlainRows(table));
});

test("cooperative dictionary text preserves sliced values and bounds large entries", withArrow, async t => {
  advanceClock(t);
  const text = "😀".repeat(18000);
  const vector = arrow.vectorFromArray(["a", text, null, text], new arrow.Dictionary(new arrow.Utf8(), new arrow.Int32()));
  const table = new arrow.Table({ value: vector }).slice(1, 4);
  let yields = 0;
  const result = await toPlainRowsCooperative(table, undefined, { yieldTask: async () => { yields++; } });
  assert.equal(yields, 4);
  assert.deepStrictEqual(result, toPlainRows(table));
});

test("cooperative UTF-8 conversion aborts after a byte-bound yield", withArrow, async t => {
  advanceClock(t);
  const table = new arrow.Table({ value: arrow.makeVector(utf8(["a".repeat(50000)])) });
  const controller = new AbortController();
  let yields = 0;
  await assert.rejects(toPlainRowsCooperative(table, undefined, { signal: controller.signal, yieldTask: async () => {
    yields++;
    controller.abort();
  } }), { name: "AbortError" });
  assert.equal(yields, 1);
});

test("cooperative row assembly yields and cancellation resumes as AbortError", async t => {
  advanceClock(t);
  const count = 2000;
  const table = { numRows: count, schema: { fields: [{ name: "n", type: "Int32" }] }, getChildAt: () => Array.from({ length: count }, (_, i) => i) };
  let resume;
  let paused;
  const reached = new Promise(resolve => { paused = resolve; });
  const controller = new AbortController();
  const old = toPlainRowsCooperative(table, undefined, { signal: controller.signal, yieldTask: () => {
    paused();
    return new Promise(resolve => { resume = resolve; });
  } });
  await reached;
  const current = await toPlainRowsCooperative(table, 3);
  controller.abort();
  resume();
  await assert.rejects(old, { name: "AbortError" });
  assert.deepStrictEqual(current, toPlainRows(table, 3));
});

test("cooperative row assignments checkpoint after at most 512 values", async t => {
  advanceClock(t);
  let consumed = 0;
  let largest = 0;
  const count = 2100;
  const source = { *[Symbol.iterator]() { for (let i = 0; i < count; i++) { consumed++; yield i; } } };
  const table = { numRows: count, schema: { fields: [{ name: "n", type: "Int32" }] }, getChildAt: () => source };
  const result = await toPlainRowsCooperative(table, undefined, { yieldTask: async () => {
    largest = Math.max(largest, consumed);
    consumed = 0;
  } });
  largest = Math.max(largest, consumed);
  assert.equal(result.rows.length, count);
  assert.equal(largest, 512);
});

test("cooperative conversion does not yield before its elapsed budget", async t => {
  advanceClock(t, 0);
  let yields = 0;
  const source = Array.from({ length: 3000 }, (_, i) => i);
  const table = { numRows: source.length, schema: { fields: [{ name: "n", type: "Int32" }] }, getChildAt: () => source };
  await toPlainRowsCooperative(table, undefined, { yieldTask: async () => { yields++; } });
  assert.equal(yields, 0);
});

test("cooperative cap avoids the excluded unsafe Arrow timestamp", withArrow, async () => {
  const table = new arrow.Table({ t: arrow.makeVector(bigints(new arrow.TimestampMillisecond(), [0n, 9223372036854775807n])) });
  assert.deepStrictEqual(await toPlainRowsCooperative(table, 0), { rows: [], fields: ["t"] });
  assert.deepStrictEqual(await toPlainRowsCooperative(table, 1), { rows: [{ t: "1970-01-01T00:00:00.000Z" }], fields: ["t"] });
  await assert.rejects(toPlainRowsCooperative(table, 2), TypeError);
});

test("cooperative conversion reuses its decoder and dictionary values", withArrow, async t => {
  const RealDecoder = globalThis.TextDecoder;
  let decoders = 0;
  let decodes = 0;
  globalThis.TextDecoder = class extends RealDecoder {
    constructor(...args) { super(...args); decoders++; }
    decode(...args) { decodes++; return super.decode(...args); }
  };
  t.after(() => { globalThis.TextDecoder = RealDecoder; });
  const values = arrow.vectorFromArray(["one", "one", "two", "one"], new arrow.Dictionary(new arrow.Utf8(), new arrow.Int32()));
  const table = new arrow.Table({ s: values });
  assert.deepStrictEqual((await toPlainRowsCooperative(table)).rows, [{ s: "one" }, { s: "one" }, { s: "two" }, { s: "one" }]);
  assert.equal(decoders, 1);
  assert.equal(decodes, 2);
});

test("cooperative conversion uses the browser scheduler when available", async t => {
  advanceClock(t);
  const original = Object.getOwnPropertyDescriptor(globalThis, "scheduler");
  let yields = 0;
  Object.defineProperty(globalThis, "scheduler", { configurable: true, value: { yield: async () => { yields++; } } });
  t.after(() => original ? Object.defineProperty(globalThis, "scheduler", original) : delete globalThis.scheduler);
  await toPlainRowsCooperative({ numRows: 600, schema: { fields: [] } });
  assert.equal(yields, 1);
});

test("cooperative LargeUtf8 yields within a large cell and cancels", withArrow, async t => {
  advanceClock(t);
  const value = "😀".repeat(20000);
  const table = new arrow.Table({ s: arrow.vectorFromArray(["x", value, null], new arrow.LargeUtf8()) }).slice(1);
  let yields = 0;
  const result = await toPlainRowsCooperative(table, undefined, { yieldTask: async () => { yields++; } });
  assert.ok(yields >= 4);
  assert.deepStrictEqual(result, toPlainRows(table));
  const controller = new AbortController();
  await assert.rejects(toPlainRowsCooperative(table, undefined, { signal: controller.signal, yieldTask: async () => controller.abort() }), { name: "AbortError" });
});

test("cooperative cancellation checks before conversion and propagates yield failures", async t => {
  advanceClock(t);
  const table = { numRows: 600, schema: { fields: [] } };
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(toPlainRowsCooperative(table, undefined, { signal: controller.signal }), { name: "AbortError" });
  const failure = new Error("yield failed");
  await assert.rejects(toPlainRowsCooperative(table, undefined, { yieldTask: async () => { throw failure; } }), error => error === failure);
});

test("toPlainRows without Arrow internals takes the iterator path", () => {
  // A table-like with no `data` chunks: no fast path applies.
  const cols = [
    [new Date("2024-03-01").getTime(), null],
    [1709251200123, undefined],
    [5n, 2n ** 60n],
  ];
  const table = {
    numRows: 2,
    schema: {
      fields: [
        { name: "d", type: "Date32<DAY>" },
        { name: "t", type: "Timestamp<MILLISECOND>" },
        { name: "n", type: "Int64" },
      ],
    },
    getChildAt: i => cols[i],
  };
  assert.deepStrictEqual(toPlainRows(table), {
    fields: ["d", "t", "n"],
    rows: [
      { d: "2024-03-01", t: "2024-03-01T00:00:00.123Z", n: 5 },
      { d: null, t: undefined, n: 2n ** 60n },
    ],
  });
});

test("mentionedBindings: identifiers only, any case, quoted names", () => {
  const names = ["enquiries", "my-binding", "binding_00", "binding_01", "binding_02", "Agents"];
  assert.deepEqual(
    mentionedBindings(
      `select * from ENQUIRIES e join "my-binding" m using (id)
       -- binding_00 in a comment
       where e.kind = 'binding_01' /* binding_02 */ and e.agent in (select id from agents)`,
      names,
    ),
    ["enquiries", "my-binding", "Agents"],
  );
  assert.deepEqual(mentionedBindings("select 1", names), []);
  assert.deepEqual(mentionedBindings("select * from enquiries", []), []);
  assert.deepEqual(mentionedBindings('select * from "we""ird"', ['we"ird']), ['we"ird']);
});

test("missingBinding reads DuckDB's catalog error", () => {
  const names = ["enquiries", "my-binding"];
  const msg = name => `Catalog Error: Table with name ${name} does not exist!\nDid you mean "x"?\n\nLINE 1: select`;
  assert.equal(missingBinding(msg("enquiries"), names), "enquiries");
  assert.equal(missingBinding(msg("ENQUIRIES"), names), "enquiries");
  assert.equal(missingBinding(msg("my-binding"), names), "my-binding");
  assert.equal(missingBinding(msg("typo"), names), null);
  assert.equal(missingBinding("Binder Error: column x not found", names), null);
});

test("readsCatalog spots table listings", () => {
  assert.equal(readsCatalog("SHOW TABLES"), true);
  assert.equal(readsCatalog("show all tables"), true);
  assert.equal(readsCatalog("select * from information_schema.tables"), true);
  assert.equal(readsCatalog("select * from duckdb_tables()"), true);
  assert.equal(readsCatalog("select * from enquiries"), false);
});

test("quoting", () => {
  assert.equal(quoteIdent('a"b'), '"a""b"');
  assert.equal(quoteString("it's"), "'it''s'");
});

test("isOutOfMemoryError reads DuckDB's message, the only signal duckdb-wasm passes", () => {
  // Both shapes seen from duckdb-wasm 1.29.0 in Chrome.
  assert.equal(isOutOfMemoryError(new Error("Out of Memory Error: failed to allocate data of size 1.0 MiB (3.1 GiB/3.1 GiB used)")), true);
  assert.equal(isOutOfMemoryError(new Error("Out of Memory Error: could not allocate block of size 256.0 KiB (37.9 MiB/38.1 MiB used)")), true);
  assert.equal(isOutOfMemoryError("Out of Memory Error: x"), true);
  assert.equal(isOutOfMemoryError(new Error("Catalog Error: Table with name x does not exist")), false);
  assert.equal(isOutOfMemoryError(null), false);
});

test("isOutOfMemoryError is anchored: quoting the words is not running out", () => {
  assert.equal(isOutOfMemoryError(new Error("Binder Error: column nope, in msg = 'Out of Memory Error'")), false);
  assert.equal(isOutOfMemoryError(new Error('Data for binding "x" could not be loaded (HTTP 502): Out of Memory Error: on the server')), false);
});

test("crashedEngineError knows the traps and no quoted word", () => {
  for (const m of ["Invalid Error: std::bad_cast", "null function", "null function or function signature mismatch", "memory access out of bounds", "table index is out of bounds", "unreachable", "Maximum call stack size exceeded"]) {
    assert.equal(crashedEngineError(new Error(m)), true, m);
  }
  assert.equal(crashedEngineError(new Error('Conversion Error: Could not convert string "unreachable" to INT32')), false);
  assert.equal(crashedEngineError(new Error('Data for binding "x" could not be loaded (HTTP 502): host unreachable')), false);
});

test("retryDelayMs reads the tag, never the words", () => {
  const tagged = (retry, extra) => Object.assign(new Error("anything"), { retry }, extra);
  assert.equal(retryDelayMs(tagged("memory"), 0), 1000);
  assert.equal(retryDelayMs(tagged("memory"), 4), 15000);
  assert.equal(retryDelayMs(tagged("memory"), 5), Infinity, "5 retries, then a sign the answer could differ");
  assert.equal(retryDelayMs(tagged("network"), 0), 5000);
  assert.equal(retryDelayMs(tagged("network"), 2), 60000);
  assert.equal(retryDelayMs(tagged("network"), 3), Infinity);
  assert.equal(retryDelayMs(tagged("network", { retryAfterMs: 900000 }), 0), 900000);
  assert.equal(retryDelayMs(new Error("Out of Memory Error: from a server"), 0), null);
  assert.equal(retryDelayMs(new TypeError("Failed to fetch"), 0), null);
});

test("isReadOnlySql: reads pass, and anything else keeps the engine", () => {
  for (const sql of [
    "SELECT 1 WHERE false",
    "  -- a note\n/* and another */ select * from x",
    "FROM x",
    "WITH a AS (SELECT 1) SELECT * FROM a",
    "(SELECT 1) UNION ALL (SELECT 2)",
    "SHOW TABLES",
    "DESCRIBE x",
    "SELECT 'CREATE TABLE y; DROP TABLE z' AS s;",
    'SELECT "update" FROM x',
    "",
  ]) {
    assert.equal(isReadOnlySql(sql), true, sql);
  }
  for (const sql of [
    "CREATE OR REPLACE TABLE journal_t AS SELECT * FROM journal",
    "-- first a comment\n create view v as select 1",
    "/* x */ INSERT INTO t VALUES (1)",
    "SELECT 1; CREATE TABLE t (a INT)",
    "WITH a AS (SELECT 1) INSERT INTO t SELECT * FROM a",
    "SET threads = 1",
    "PRAGMA enable_profiling",
    "ATTACH 'x.db'",
    "COPY x TO 'y.parquet'",
    "BEGIN",
    "something_new x",
  ]) {
    assert.equal(isReadOnlySql(sql), false, sql);
  }
});

test("largeQueryWarning: silent up to the limit, names the binding and useDuckDB past it", () => {
  assert.equal(LARGE_QUERY_ROWS, 20000);
  assert.equal(largeQueryWarning("orders", 0), null);
  assert.equal(largeQueryWarning("orders", 20000), null);
  assert.equal(largeQueryWarning("orders", undefined), null);
  const msg = largeQueryWarning("orders", 193412);
  assert.match(msg, /useQuery\("orders"\) returned 193,412 rows/);
  assert.match(msg, /useDuckDB\("select … from "orders" where …"\)/);
  assert.equal(largeQueryWarning("orders", 600, 500)?.includes("600 rows"), true);
});
