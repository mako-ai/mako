// Stand-in for the duckdb-wasm ESM the SDK imports from jsDelivr, so
// index.test.mjs runs in Node. State lives on globalThis.__fakeDuck.
//
// Memory: each table holds `tableBytes` (0 unless a test sets it), views hold
// nothing, and duckdb_memory() reports the sum, as the real engine does
// (a view's parquet copy sits in the heap outside duckdb_memory(), as measured).
// A query whose SQL matches `oom` fails with DuckDB's Out of Memory message,
// `oomTimes` times (default once). Like DuckDB, CREATE OR REPLACE refuses to
// swap a view for a table or back.
const state = (globalThis.__fakeDuck ??= {
  boots: 0,
  sql: [],
  files: new Map(),
  handles: new Map(),
  open: 0,
  tables: new Set(),
  views: new Map(), // name -> file it reads
  tableBytes: 0,
  oom: null,
});
export const getJsDelivrBundles = () => ({});
export const selectBundle = async () => ({ mainModule: "m", mainWorker: "w", pthreadWorker: null });
export const createWorker = async () => ({});
export const DuckDBDataProtocol = { BUFFER: 0, NODE_FS: 1, BROWSER_FILEREADER: 2, BROWSER_FSACCESS: 3, HTTP: 4, S3: 5 };
export class VoidLogger {}

const result = (value, fields = [{ name: "x", type: "Int32" }]) => ({
  numRows: value === undefined ? 0 : 1,
  schema: { fields },
  getChildAt: () => ({ get: () => value }),
  [Symbol.iterator]: [][Symbol.iterator],
});

export class AsyncDuckDB {
  async instantiate() {
    state.boots++;
  }
  async registerFileBuffer(name, buf) {
    state.files.set(name, buf);
  }
  async registerFileHandle(name, handle, protocol, direct) {
    state.handles.set(name, { handle, protocol, direct });
  }
  async dropFile(name) {
    state.files.delete(name);
    state.handles.delete(name);
  }
  async connect() {
    state.open++;
    return {
      async query(sql) {
        state.sql.push(sql);
        if (state.oom && state.oom.test(sql)) {
          state.oomTimes = (state.oomTimes ?? 1) - 1;
          if (state.oomTimes <= 0) {
            state.oom = null;
            state.oomTimes = 1;
          }
          throw new Error("Out of Memory Error: failed to allocate data of size 1.0 MiB (3.1 GiB/3.1 GiB used)");
        }
        if (/FROM duckdb_memory\(\)/.test(sql)) {
          return result(state.tables.size * state.tableBytes, [{ name: "bytes", type: "Float64" }]);
        }
        const t = /^CREATE OR REPLACE TABLE "(.+?)"/.exec(sql);
        if (t) {
          if (state.views.has(t[1])) throw new Error("Catalog Error: Existing object " + t[1] + " is of type View, trying to replace with type Table");
          state.tables.add(t[1]);
        }
        const v = /^CREATE OR REPLACE VIEW "(.+?)" AS SELECT \* FROM read_parquet\('(.+?)'\)/.exec(sql);
        if (v) {
          if (state.tables.has(v[1])) throw new Error("Catalog Error: Existing object " + v[1] + " is of type Table, trying to replace with type View");
          state.views.set(v[1], v[2]);
        }
        const d = /^DROP TABLE IF EXISTS "(.+?)"/.exec(sql);
        if (d) state.tables.delete(d[1]);
        const dv = /^DROP VIEW IF EXISTS "(.+?)"/.exec(sql);
        if (dv) state.views.delete(dv[1]);
        if (sql === "FAIL") throw new Error("boom");
        return result(undefined);
      },
      async close() {
        state.open--;
      },
    };
  }
}
