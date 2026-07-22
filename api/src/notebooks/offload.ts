/**
 * Large-output offload.
 *
 * Cell outputs are stored inline in the notebook document (GCS/fs). A big
 * `result`/`display` mime payload — a matplotlib PNG, a wide pandas HTML table
 * — would bloat the document (re-downloaded/re-uploaded on every autosave) or,
 * past the client's per-cell budget, be dropped entirely. Instead we offload
 * such payloads to the store as separate artifacts and leave a small
 * {@link NotebookArtifactRef} in their place, so documents stay lean and no
 * output is ever lost. The client fetches them back via
 * `GET …/notebooks/:id/artifacts/:artifactId`.
 *
 * Called on every server-side write path (the PATCH route for human runs, the
 * agent's persistOutputs for agent runs) so both benefit uniformly. Idempotent:
 * an already-offloaded entry is left untouched, so retries/re-saves never
 * re-upload. Stream text and SQL rows keep their existing inline caps — they
 * degrade gracefully and re-run, so they aren't worth an extra fetch.
 */
import { randomUUID } from "crypto";

import { loggers } from "../logging";
import type { NotebookStore } from "./store/types";
import type { NotebookBlock, NotebookCellOutput } from "./types";

const logger = loggers.api("notebook-offload");

/** A string mime value longer than this is offloaded rather than inlined. */
const OFFLOAD_MIME_BYTES = 32 * 1024;

/** Mime keys whose value is base64-encoded binary (decode before storing). */
const BASE64_MIMES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

function encodeMime(
  mimeKey: string,
  value: string,
): { buffer: Buffer; contentType: string } {
  if (BASE64_MIMES.has(mimeKey)) {
    return { buffer: Buffer.from(value, "base64"), contentType: mimeKey };
  }
  const isText = mimeKey.startsWith("text/") || mimeKey === "image/svg+xml";
  return {
    buffer: Buffer.from(value, "utf8"),
    contentType: isText ? `${mimeKey}; charset=utf-8` : mimeKey,
  };
}

/** Offload large mime payloads in one cell's outputs. Returns the same array
 * reference when nothing changed (so callers can skip re-saving). */
export async function offloadOutputs(
  store: NotebookStore,
  workspaceId: string,
  notebookId: string,
  outputs: NotebookCellOutput[] | undefined,
): Promise<NotebookCellOutput[] | undefined> {
  if (!outputs?.length) return outputs;

  let changed = false;
  const result: NotebookCellOutput[] = [];
  for (const output of outputs) {
    if (output.type !== "result" && output.type !== "display") {
      result.push(output);
      continue;
    }

    let data = output.data;
    let artifacts = output.artifacts ?? {};
    let outChanged = false;
    for (const [mimeKey, value] of Object.entries(output.data)) {
      if (typeof value !== "string" || value.length <= OFFLOAD_MIME_BYTES) {
        continue;
      }
      if (artifacts[mimeKey]) continue; // already offloaded

      const { buffer, contentType } = encodeMime(mimeKey, value);
      const artifactId = randomUUID();
      try {
        await store.putArtifact(
          workspaceId,
          notebookId,
          artifactId,
          buffer,
          contentType,
        );
      } catch (err) {
        // Keep the payload inline rather than lose it if the upload fails.
        logger.warn("Failed to offload notebook output; keeping inline", {
          notebookId,
          mimeKey,
          error: err,
        });
        continue;
      }

      if (!outChanged) {
        data = { ...output.data };
        artifacts = { ...artifacts };
        outChanged = true;
      }
      delete (data as Record<string, unknown>)[mimeKey];
      artifacts[mimeKey] = { artifactId, contentType, size: buffer.length };
    }

    if (outChanged) {
      changed = true;
      result.push({ ...output, data, artifacts });
    } else {
      result.push(output);
    }
  }

  return changed ? result : outputs;
}

/** Offload every block's outputs. Returns a new blocks array only if something
 * changed; otherwise the input reference. */
export async function offloadBlocks(
  store: NotebookStore,
  workspaceId: string,
  notebookId: string,
  blocks: NotebookBlock[],
): Promise<NotebookBlock[]> {
  let changed = false;
  const next = await Promise.all(
    blocks.map(async block => {
      const outputs = await offloadOutputs(
        store,
        workspaceId,
        notebookId,
        block.outputs,
      );
      if (outputs === block.outputs) return block;
      changed = true;
      return { ...block, outputs };
    }),
  );
  return changed ? next : blocks;
}
