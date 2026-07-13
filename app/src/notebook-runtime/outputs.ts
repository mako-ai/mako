/**
 * Output caps for persistence. Cell outputs are stored inline in the notebook
 * document (GCS), so we bound their size: truncate long stream text and stop
 * persisting a cell's outputs once a byte budget is exceeded. Large-output
 * offload to GCS (with a ref) is a follow-up.
 */
import type { KernelOutput } from "./kernel";

const MAX_STREAM_CHARS = 50_000; // per stream chunk
const MAX_TOTAL_BYTES = 512 * 1024; // per cell, all outputs combined
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
