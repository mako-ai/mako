/**
 * Notebook document model.
 *
 * A notebook is an ordered list of blocks. SQL blocks execute in the control
 * plane through the existing driver layer (no kernel); code blocks run on the
 * notebook kernel once the execution plane lands. This is a deliberately small,
 * Deepnote-block-shaped schema — the canonical `.deepnote` format + richer
 * block types (via `@deepnote/blocks`/`@deepnote/convert`) come with the Git
 * storage/interop slice.
 */
export type NotebookBlockType = "code" | "sql" | "markdown";

/**
 * Reference to a large output payload offloaded to the store (GCS/fs) instead
 * of being inlined in the notebook document. Keeps documents small and means a
 * big plot / HTML table is never dropped. Fetched via
 * `GET …/notebooks/:id/artifacts/:artifactId`.
 */
export interface NotebookArtifactRef {
  /** Opaque id; the object key is derived from workspace + notebook + this. */
  artifactId: string;
  /** MIME content type to serve the bytes with (mirrors the mime-bundle key). */
  contentType: string;
  /** Size in bytes of the stored payload. */
  size: number;
}

/**
 * A rendered output persisted with a cell so it survives reload. `stream` /
 * `result` / `display` / `error` mirror the kernel's Jupyter outputs (Python
 * cells); `sql` holds a SQL cell's result set. Documents stay small: long
 * stream text is truncated and large `result`/`display` mime payloads are
 * offloaded to the store — their inline value is dropped from `data` and moved
 * to `artifacts[mimeKey]` as a {@link NotebookArtifactRef}.
 */
export type NotebookCellOutput =
  | { type: "stream"; name: "stdout" | "stderr"; text: string }
  | {
      type: "result";
      data: Record<string, unknown>;
      artifacts?: Record<string, NotebookArtifactRef>;
    }
  | {
      type: "display";
      data: Record<string, unknown>;
      artifacts?: Record<string, NotebookArtifactRef>;
    }
  | { type: "error"; ename: string; evalue: string; traceback: string[] }
  | {
      type: "sql";
      rows: unknown[];
      fields?: Array<{ name?: string; originalName?: string } | string>;
      rowCount: number;
      executionTime?: number;
      truncated?: boolean;
    };

export interface NotebookBlock {
  id: string;
  type: NotebookBlockType;
  source: string;
  /** SQL blocks target a Mako data source; code blocks run on the kernel. */
  connectionId?: string;
  /** Persisted outputs from the last execution (so they survive reload). */
  outputs?: NotebookCellOutput[];
  /** The kernel's execution counter for code cells (`In [n]`). */
  executionCount?: number;
  /** ISO timestamp of the last execution. */
  executedAt?: string;
}

export interface NotebookDoc {
  id: string;
  name: string;
  blocks: NotebookBlock[];
  /** Monotonic version, bumped on every save. Drives realtime poke-then-pull. */
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface NotebookSummary {
  id: string;
  name: string;
  updatedAt: string;
}
