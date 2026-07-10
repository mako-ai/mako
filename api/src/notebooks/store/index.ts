/**
 * Notebook store selection. `NOTEBOOK_GCS_BUCKET` (set in deployed
 * environments) selects the durable, shareable GCS store; otherwise notebooks
 * fall back to the local filesystem (dev only, ephemeral). Memoized singleton.
 */
import { loggers } from "../../logging";
import { FilesystemNotebookStore } from "./filesystem-store";
import { GcsNotebookStore } from "./gcs-store";
import type { NotebookStore } from "./types";

const logger = loggers.api("notebooks");

function resolveStore(): NotebookStore {
  const bucket = process.env.NOTEBOOK_GCS_BUCKET;
  if (bucket) {
    // Prefix scopes storage per environment (prod vs a pr-N preview) so preview
    // envs — whose DBs are seeded from prod and share workspace ids — never
    // read or clobber production notebooks in the shared bucket.
    const prefix = process.env.NOTEBOOK_GCS_PREFIX || "documents";
    logger.info("Using GCS notebook store", { bucket, prefix });
    return new GcsNotebookStore(bucket, prefix);
  }
  logger.info("Using filesystem notebook store (ephemeral — dev only)");
  return new FilesystemNotebookStore();
}

let cached: NotebookStore | null = null;

/** The active notebook store (GCS in deployed envs, filesystem locally). */
export function getNotebookStore(): NotebookStore {
  cached ??= resolveStore();
  return cached;
}

/** Test seam: forget the memoized store (e.g. after changing env). */
export function resetNotebookStoreForTests(): void {
  cached = null;
}

export type { NotebookStore } from "./types";
