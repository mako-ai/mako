/**
 * Transport-neutral notebook capability metadata.
 *
 * Notebooks are durable (GCS) with server-side kernels, so the whole domain
 * is exposed on every surface. Cell runs execute real queries / kernel code
 * and carry the query envelope where warehouse access is involved.
 */
import {
  ALL_AGENT_SURFACES,
  IN_CHAT_ONLY_SURFACES,
  type AgentCapabilityDefinition,
} from "./types";

export type NotebookCapabilityPack =
  "notebook-orient" | "notebook-edit" | "notebook-run";

export type NotebookCapabilityDefinition = AgentCapabilityDefinition<
  "notebook",
  NotebookCapabilityPack
>;

const define = (
  definition: Omit<NotebookCapabilityDefinition, "domain">,
): NotebookCapabilityDefinition => ({ domain: "notebook", ...definition });

export const NOTEBOOK_CAPABILITIES = [
  // ── Orientation / reads ─────────────────────────────────────────────────
  define({
    name: "list_open_notebooks",
    pack: "notebook-orient",
    risk: "read",
    surfaces: ALL_AGENT_SURFACES,
    resultKind: "data",
  }),
  define({
    name: "read_notebook",
    pack: "notebook-orient",
    risk: "read",
    surfaces: ALL_AGENT_SURFACES,
    resultKind: "data",
  }),
  define({
    name: "read_notebook_cell",
    pack: "notebook-orient",
    risk: "read",
    surfaces: ALL_AGENT_SURFACES,
    resultKind: "data",
  }),
  define({
    name: "search_notebook",
    pack: "notebook-orient",
    risk: "read",
    surfaces: ALL_AGENT_SURFACES,
    resultKind: "data",
  }),
  // ── Authoring ───────────────────────────────────────────────────────────
  define({
    name: "create_notebook",
    pack: "notebook-edit",
    risk: "write",
    requiredGrant: "artifact-write",
    surfaces: ALL_AGENT_SURFACES,
    resultKind: "artifact",
  }),
  define({
    // Single cell CRUD tool: mode 'insert' | 'replace' (default) | 'delete'.
    // The delete leg is recoverable via notebook versions and needs the same
    // artifact-write grant, so the merged tool stays write-risk; the
    // deprecated delete_notebook_cell alias below keeps its destructive hint.
    name: "edit_notebook_cell",
    pack: "notebook-edit",
    risk: "write",
    requiredGrant: "artifact-write",
    surfaces: ALL_AGENT_SURFACES,
    resultKind: "artifact",
  }),
  define({
    // Deprecated alias of edit_notebook_cell (mode: 'insert'); kept
    // registered for chats that already called it, deferred out of the
    // in-product working set (see DEFERRED_BUILTIN_TOOL_DOMAINS) and off the
    // MCP surfaces, which expose edit_notebook_cell.
    name: "add_notebook_cell",
    pack: "notebook-edit",
    risk: "write",
    requiredGrant: "artifact-write",
    surfaces: IN_CHAT_ONLY_SURFACES,
    resultKind: "artifact",
    mcpExclusion: {
      why: "deferred",
      note: "Deprecated alias; MCP exposes edit_notebook_cell.",
    },
  }),
  define({
    // Deprecated alias of edit_notebook_cell (mode: 'delete'); kept
    // registered for chats that already called it, deferred out of the
    // in-product working set (see DEFERRED_BUILTIN_TOOL_DOMAINS) and off the
    // MCP surfaces, which expose edit_notebook_cell.
    name: "delete_notebook_cell",
    pack: "notebook-edit",
    risk: "destructive",
    requiredGrant: "artifact-write",
    surfaces: IN_CHAT_ONLY_SURFACES,
    resultKind: "artifact",
    mcpExclusion: {
      why: "deferred",
      note: "Deprecated alias; MCP exposes edit_notebook_cell.",
    },
  }),
  // ── Cell runs ───────────────────────────────────────────────────────────
  define({
    // Runs a warehouse query, so it needs the same query envelope as
    // sql_execute_query / run_console.
    name: "run_notebook_sql_cell",
    pack: "notebook-run",
    risk: "write",
    surfaces: ALL_AGENT_SURFACES,
    resultKind: "run",
    requiresQueryAccess: true,
  }),
  define({
    name: "run_notebook_code_cell",
    pack: "notebook-run",
    risk: "write",
    surfaces: ALL_AGENT_SURFACES,
    resultKind: "run",
  }),
] as const satisfies readonly NotebookCapabilityDefinition[];
