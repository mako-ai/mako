// Stand-in for the duckdb-wasm ESM the SDK imports from jsDelivr, so
// index.test.mjs runs in Node. State lives on globalThis.__fakeDuck.
const state = (globalThis.__fakeDuck ??= { boots: 0, sql: [], files: new Map(), open: 0, tables: new Set() });
export const getJsDelivrBundles = () => ({});
export const selectBundle = async () => ({ mainModule: "m", mainWorker: "w", pthreadWorker: null });
export const createWorker = async () => ({});
export class VoidLogger {}
export class AsyncDuckDB {
  async instantiate() {
    state.boots++;
  }
  async registerFileBuffer(name, buf) {
    state.files.set(name, buf);
  }
  async dropFile(name) {
    state.files.delete(name);
  }
  async connect() {
    state.open++;
    return {
      async query(sql) {
        state.sql.push(sql);
        const m = /^CREATE OR REPLACE TABLE "(.+?)"/.exec(sql);
        if (m) state.tables.add(m[1]);
        const d = /^DROP TABLE IF EXISTS "(.+?)"/.exec(sql);
        if (d) state.tables.delete(d[1]);
        if (sql === "FAIL") throw new Error("boom");
        return { numRows: 0, schema: { fields: [{ name: "x", type: "Int32" }] }, getChildAt: () => [], [Symbol.iterator]: [][Symbol.iterator] };
      },
      async close() {
        state.open--;
      },
    };
  }
}
