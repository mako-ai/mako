/**
 * Minimal `.ipynb` (Jupyter nbformat 4) ↔ Mako notebook-block conversion.
 *
 * Maps Mako blocks to standard cells so notebooks import/export cleanly:
 *  - markdown block ↔ markdown cell
 *  - code block     ↔ code cell (Python)
 *  - sql block      ↔ code cell carrying `metadata.mako = { type, connectionId }`
 *    (round-trips SQL cells; opens as a normal code cell in vanilla Jupyter)
 *
 * The richer, lossless `.deepnote` format via `@deepnote/convert` arrives with
 * the Git-storage slice; this covers `.ipynb` interop today.
 */
import type { NotebookBlock, NotebookBlockType } from "../store/notebookStore";

interface IpynbCell {
  cell_type: string;
  metadata?: Record<string, unknown>;
  source?: string | string[];
  execution_count?: number | null;
  outputs?: unknown[];
}

export interface Ipynb {
  nbformat?: number;
  nbformat_minor?: number;
  metadata?: Record<string, unknown>;
  cells?: IpynbCell[];
}

/** nbformat multiline string: keep each line's trailing newline except the last. */
function toLines(source: string): string[] {
  const parts = source.split("\n");
  return parts.map((line, i) => (i < parts.length - 1 ? line + "\n" : line));
}

function fromSource(source: string | string[] | undefined): string {
  return Array.isArray(source) ? source.join("") : (source ?? "");
}

export function notebookToIpynb(name: string, blocks: NotebookBlock[]): Ipynb {
  return {
    nbformat: 4,
    nbformat_minor: 5,
    metadata: { mako: { name } },
    cells: blocks.map(b => {
      if (b.type === "markdown") {
        return {
          cell_type: "markdown",
          metadata: {},
          source: toLines(b.source),
        };
      }
      const mako: Record<string, unknown> = { type: b.type };
      if (b.type === "sql" && b.connectionId) {
        mako.connectionId = b.connectionId;
      }
      return {
        cell_type: "code",
        metadata: { mako },
        execution_count: null,
        outputs: [],
        source: toLines(b.source),
      };
    }),
  };
}

export function nameFromIpynb(json: Ipynb, fallback: string): string {
  const mako = json.metadata?.mako as { name?: unknown } | undefined;
  return typeof mako?.name === "string" && mako.name.trim()
    ? mako.name
    : fallback;
}

export function blocksFromIpynb(json: Ipynb): NotebookBlock[] {
  const cells = Array.isArray(json.cells) ? json.cells : [];
  return cells.map(cell => {
    const source = fromSource(cell.source);
    const mako = (cell.metadata?.mako ?? {}) as {
      type?: unknown;
      connectionId?: unknown;
    };
    let type: NotebookBlockType;
    if (cell.cell_type === "markdown" || cell.cell_type === "raw") {
      type = "markdown";
    } else {
      type = mako.type === "sql" ? "sql" : "code";
    }
    const block: NotebookBlock = { id: crypto.randomUUID(), type, source };
    if (type === "sql" && typeof mako.connectionId === "string") {
      block.connectionId = mako.connectionId;
    }
    return block;
  });
}
