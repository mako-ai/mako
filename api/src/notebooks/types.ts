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

export interface NotebookBlock {
  id: string;
  type: NotebookBlockType;
  source: string;
  /** SQL blocks target a Mako data source; code blocks run on the kernel. */
  connectionId?: string;
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
