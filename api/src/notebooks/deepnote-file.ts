/**
 * Notebooks as `.deepnote` files (apps.md §24): the pure format layer.
 *
 * The committed file is Deepnote's OPEN project format (validated against
 * `@deepnote/blocks`' canonical zod schema), single-notebook variant — so a
 * notebook committed to the workspace repo opens in Deepnote, converts to
 * .ipynb/Quarto/percent/Marimo with `npx @deepnote/convert`, and renders as
 * ordinary YAML in any diff view.
 *
 * OUTPUTS ARE STRIPPED — Deepnote's own architecture (source file clean;
 * execution snapshots live elsewhere), the nbstripout convention, and ours:
 * rendered outputs stay in the hot store document and the artifact store.
 *
 * Paths: `notebooks/<slug>.deepnote` for workspace-visible notebooks,
 * `users/<ownerId>/notebooks/<slug>.deepnote` for private ones — the same
 * owner-first layout consoles use.
 */
import { createHash, randomUUID } from "node:crypto";
import yaml from "js-yaml";
import { deepnoteFileSchema } from "@deepnote/blocks";
import type { NotebookBlock, NotebookDoc } from "./types";

export const NOTEBOOK_FILE_EXTENSION = ".deepnote";
export const NOTEBOOKS_ROOT = "notebooks";

/** Mako-specific keys carried inside block/notebook metadata (round-trip). */
const MAKO_CONNECTION_KEY = "mako_connection_id";

export function slugifyNotebookName(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return slug || "notebook";
}

export function notebookRepoPath(
  slug: string,
  owner?: { access: "private" | "workspace"; ownerId: string },
): string {
  if (owner && owner.access === "private") {
    return `users/${owner.ownerId}/${NOTEBOOKS_ROOT}/${slug}${NOTEBOOK_FILE_EXTENSION}`;
  }
  return `${NOTEBOOKS_ROOT}/${slug}${NOTEBOOK_FILE_EXTENSION}`;
}

export function isNotebookRepoPath(repoRelative: string): boolean {
  return (
    repoRelative.endsWith(NOTEBOOK_FILE_EXTENSION) &&
    (repoRelative.startsWith(`${NOTEBOOKS_ROOT}/`) ||
      /^users\/[^/]+\/notebooks\//.test(repoRelative))
  );
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Deterministic uuid (v5-style, sha1 of the inputs): serialization must be
 * BYTE-STABLE for identical documents — the checkpoint pipeline levels on
 * blob shas, so a random uuid per run would make every checkpoint "dirty".
 */
function stableUuid(...parts: string[]): string {
  const h = createHash("sha1").update(parts.join("\u0000")).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** Serialize a NotebookDoc to the .deepnote YAML (outputs stripped). */
export function serializeNotebookFile(doc: NotebookDoc): string {
  const blocks = doc.blocks.map((block, i) => {
    const metadata: Record<string, unknown> = {};
    if (!UUID_RE.test(block.id)) metadata.mako_block_id = block.id;
    const blockId = UUID_RE.test(block.id)
      ? block.id
      : stableUuid(doc.id, block.id);
    if (block.type === "sql" && block.connectionId) {
      // Deepnote's own key for the datasource binding, so the file means
      // something outside Mako too; the Mako key is the round-trip anchor.
      metadata.sql_integration_id = block.connectionId;
      metadata[MAKO_CONNECTION_KEY] = block.connectionId;
    }
    return {
      id: blockId,
      blockGroup: stableUuid(doc.id, block.id, "group"),
      sortingKey: String(i).padStart(6, "0"),
      type: block.type,
      content: block.source,
      metadata,
    };
  });
  const file = {
    version: "1.0.0",
    metadata: { createdAt: doc.createdAt },
    project: {
      id: doc.id,
      name: doc.name,
      integrations: [],
      notebooks: [
        {
          id: doc.id,
          name: doc.name,
          executionMode: "block",
          isModule: false,
          blocks,
        },
      ],
      settings: {},
    },
  };
  const validated = deepnoteFileSchema.safeParse(file);
  if (!validated.success) {
    // Never write a file the canonical schema rejects — fail loudly so the
    // checkpoint pipeline surfaces it instead of committing junk.
    throw new Error(
      `Notebook does not serialize to a valid .deepnote file: ${validated.error.issues[0]?.message ?? "unknown"}`,
    );
  }
  return yaml.dump(file, { lineWidth: 100, noRefs: true, sortKeys: true });
}

export interface ParsedNotebookFile {
  /** The notebook id embedded in the file (project/notebook id). */
  id: string | null;
  name: string;
  blocks: NotebookBlock[];
}

/**
 * Parse a .deepnote file back into our block model. Tolerant by design:
 * external files may carry Deepnote block types we do not model — text
 * cells fold into markdown, unknown executable types fold into code, and
 * anything unrecognizable is skipped with the file still accepted.
 */
export function parseNotebookFile(contents: string): ParsedNotebookFile | null {
  let raw: unknown;
  try {
    raw = yaml.load(contents);
  } catch {
    return null;
  }
  const parsed = deepnoteFileSchema.safeParse(raw);
  if (!parsed.success) return null;
  const project = parsed.data.project as {
    id?: string;
    name?: string;
    notebooks?: Array<{
      id?: string;
      name?: string;
      blocks?: Array<{
        id?: string;
        type?: string;
        content?: string;
        metadata?: Record<string, unknown> | null;
      }>;
    }>;
  };
  const notebook = project.notebooks?.[0];
  if (!notebook) return null;

  const blocks: NotebookBlock[] = [];
  for (const block of notebook.blocks ?? []) {
    const metadata = (block.metadata ?? {}) as Record<string, unknown>;
    const id =
      typeof metadata.mako_block_id === "string"
        ? metadata.mako_block_id
        : (block.id ?? randomUUID());
    const content = typeof block.content === "string" ? block.content : "";
    const type = block.type ?? "";
    if (type === "markdown" || type.startsWith("text-cell-")) {
      blocks.push({ id, type: "markdown", source: content });
    } else if (type === "sql") {
      const connectionId =
        typeof metadata[MAKO_CONNECTION_KEY] === "string"
          ? (metadata[MAKO_CONNECTION_KEY] as string)
          : typeof metadata.sql_integration_id === "string"
            ? (metadata.sql_integration_id as string)
            : undefined;
      blocks.push({ id, type: "sql", source: content, connectionId });
    } else if (type === "code") {
      blocks.push({ id, type: "code", source: content });
    } else if (content.trim()) {
      // Unmodeled Deepnote block (visualization, input, …): preserve its
      // content as a code comment rather than dropping user work.
      blocks.push({ id, type: "code", source: content });
    }
  }
  return {
    id: notebook.id ?? project.id ?? null,
    name: notebook.name?.trim() || project.name?.trim() || "Untitled notebook",
    blocks,
  };
}
