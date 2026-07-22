/**
 * Output caps for persistence. Long stream text is truncated here; large
 * `result`/`display` mime payloads (plots, HTML tables) are kept intact and
 * sent to the server, which offloads them to the store and leaves a small ref
 * in the document (see api `notebooks/offload.ts`). The per-cell byte budget is
 * only a backstop against a pathological payload blowing up the save request —
 * it sits well above a typical plot + table so those reach the server and get
 * offloaded rather than dropped.
 */
import type { KernelOutput } from "./kernel";

const MAX_STREAM_CHARS = 50_000; // per stream chunk
const MAX_TOTAL_BYTES = 6 * 1024 * 1024; // per cell, all outputs combined
export const MAX_PERSIST_SQL_ROWS = 200;

/** Truncate long stream text and drop outputs past the per-cell byte budget. */
export function capKernelOutputs(outputs: KernelOutput[]): KernelOutput[] {
  const capped: KernelOutput[] = [];
  let bytes = 0;
  for (const o of outputs) {
    const out: KernelOutput =
      o.type === "stream" && o.text.length > MAX_STREAM_CHARS
        ? { ...o, text: o.text.slice(0, MAX_STREAM_CHARS) + "\n… (truncated)" }
        : o;
    bytes += JSON.stringify(out).length;
    if (bytes > MAX_TOTAL_BYTES) {
      capped.push({
        type: "stream",
        name: "stderr",
        text: "… (remaining output too large to persist)",
      });
      break;
    }
    capped.push(out);
  }
  return capped;
}

/** Cap the rows persisted for a SQL result. */
export function capSqlRows(rows: unknown[]): {
  rows: unknown[];
  truncated: boolean;
} {
  if (rows.length <= MAX_PERSIST_SQL_ROWS) return { rows, truncated: false };
  return { rows: rows.slice(0, MAX_PERSIST_SQL_ROWS), truncated: true };
}
