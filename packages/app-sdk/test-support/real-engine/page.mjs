// Runs in headless Chromium, bundled with one SDK build by measure.mjs. Mounts
// useDuckDB panels the way a dashboard does and lets the runner change their
// SQL in place. window.H is what the runner drives.
import * as React from "react";
import { createRoot } from "react-dom/client";
import * as sdk from "SDK_UNDER_TEST";

const panels = new Map(); // index -> latest hook result
let setSqlState = null;

function Panel({ index, sql }) {
  const r = sdk.useDuckDB(sql);
  const first = r.data?.[0] ?? null;
  panels.set(index, { sql, error: r.error, loading: r.loading, rowCount: r.rowCount, first: first && JSON.stringify(first, (k, v) => (typeof v === "bigint" ? Number(v) : v)) });
  return null;
}
function App({ initial }) {
  const [sqls, setSqls] = React.useState(initial);
  setSqlState = setSqls;
  return sqls.map((sql, i) => React.createElement(Panel, { key: i, index: i, sql }));
}

let root = null;
window.H = {
  sdkVersion: sdk.SDK_VERSION,
  setBudget: (bytes, blob) => sdk.setBindingMemoryBudget?.(bytes, blob ? { blobBytes: blob } : undefined),
  mount(sqls) {
    panels.clear();
    root ??= createRoot(document.getElementById("root"));
    root.render(React.createElement(App, { initial: sqls }));
  },
  setSqls(sqls) {
    setSqlState(sqls);
  },
  unmount() {
    root?.unmount();
    root = null;
    panels.clear();
  },
  panels: () => [...panels.values()],
  async bindings() {
    const info = await sdk.getBindingMemory();
    const count = {};
    for (const b of info.bindings) count[b.storage] = (count[b.storage] ?? 0) + 1;
    return { count, usedMiB: Math.round(info.usedBytes / 1048576) };
  },
  async memory() {
    const db = await sdk.getDuckDB();
    const conn = await db.connect();
    try {
      const tags = (await conn.query(
        "SELECT tag, memory_usage_bytes::DOUBLE b, temporary_storage_bytes::DOUBLE s FROM duckdb_memory() WHERE memory_usage_bytes > 0 OR temporary_storage_bytes > 0",
      )).toArray().map(r => [r.tag, Math.round(r.b / 1048576), Math.round(r.s / 1048576)]);
      const limit = (await conn.query("SELECT current_setting('memory_limit') m")).toArray()[0].m;
      const catalog = (await conn.query(
        "SELECT (SELECT count(*) FROM duckdb_tables() WHERE NOT internal)::INT t, (SELECT count(*) FROM duckdb_views() WHERE NOT internal)::INT v",
      )).toArray()[0];
      const info = sdk.getBindingMemory ? await sdk.getBindingMemory() : null;
      return {
        limit,
        tags,
        heldMiB: tags.reduce((s, t) => s + t[1], 0),
        tables: catalog.t,
        views: catalog.v,
        pinned: info ? info.bindings.filter(b => b.pinned).length : null,
        pressure: info?.pressure ?? null,
      };
    } finally {
      await conn.close();
    }
  },
  async sql(q) {
    const db = await sdk.getDuckDB();
    const conn = await db.connect();
    const t0 = performance.now();
    try {
      const res = await conn.query(q);
      return { ms: Math.round(performance.now() - t0), rows: res.numRows, first: res.numRows ? JSON.parse(JSON.stringify(res.get(0)?.toJSON?.() ?? null, (k, v) => (typeof v === "bigint" ? Number(v) : v))) : null };
    } catch (e) {
      return { ms: Math.round(performance.now() - t0), error: String(e.message ?? e) };
    } finally {
      await conn.close();
    }
  },
  // Raw engine calls for the heap probes: no hooks, no SDK bookkeeping.
  async fileBufferFromUrl(file, url) {
    const db = await sdk.getDuckDB();
    const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
    try {
      await db.registerFileBuffer(file, bytes);
      return { ok: true, size: bytes.length };
    } catch (e) {
      return { error: String(e.message ?? e) };
    }
  },
  async drop(file) {
    const db = await sdk.getDuckDB();
    await db.dropFile(file);
  },
  async fileHandleFromUrl(file, url) {
    const db = await sdk.getDuckDB();
    const blob = await (await fetch(url)).blob();
    try {
      await db.registerFileHandle(file, blob, 2, true);
      return { ok: true, size: blob.size };
    } catch (e) {
      return { error: String(e.message ?? e) };
    }
  },
  async generate(name, selectSql) {
    const db = await sdk.getDuckDB();
    const conn = await db.connect();
    try {
      const file = name + ".gen.parquet";
      await db.registerEmptyFileBuffer(file);
      await conn.query("COPY (" + selectSql + ") TO '" + file + "' (FORMAT PARQUET, COMPRESSION SNAPPY)");
      const bytes = await db.copyFileToBuffer(file);
      await db.dropFile(file);
      const r = await fetch("/__store/" + name, { method: "POST", body: bytes });
      if (!r.ok) throw new Error("store failed");
      return bytes.byteLength;
    } finally {
      await conn.close();
    }
  },
};
