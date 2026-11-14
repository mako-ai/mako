/**
 * Transport-neutral capability metadata for `rename_object` — the one tool
 * that renames every kind of workspace object (api/src/rename).
 *
 * One tool must not widen what the per-kind tools allow, so each kind keeps
 * the gate its own write path has on agent surfaces:
 *
 *   - dbt jobs: `warehouse-write`, like dbt_update_job — a job is scheduler
 *     configuration that runs against the warehouse;
 *   - skills and workspace connectors: `git-write`. MCP is read-only for
 *     skills (save_skill is excluded there), and a connector rename moves
 *     code AND re-points every connection of that connector;
 *   - connections: `connections-manage`, and the external MCP surface only —
 *     exactly `update_connection`, which renames a source connection today.
 *     It is kept out of the in-product chat and the desktop agent so a
 *     prompt-injected page cannot change a credential the workspace syncs
 *     from, and a rename is one of the changes that tool makes;
 *   - apps, consoles, notebooks, flows, dbt files: no extra grant — the same
 *     authority app_move_app, modify_console and edit_dbt_file already have.
 *
 * The rename services re-check the caller's live role and per-object access
 * on every call; these gates are the agent-surface layer on top.
 */
import {
  ALL_AGENT_SURFACES,
  type AgentCapabilityDefinition,
  type AgentSurface,
} from "./types";

export type RenameCapabilityPack = "rename";

export type RenameCapabilityDefinition = AgentCapabilityDefinition<
  "workspace",
  RenameCapabilityPack
>;

const define = (
  definition: Omit<RenameCapabilityDefinition, "domain">,
): RenameCapabilityDefinition => ({ domain: "workspace", ...definition });

const kindIs =
  (...kinds: string[]) =>
  (input: unknown): boolean =>
    typeof input === "object" &&
    input !== null &&
    kinds.includes(String((input as { kind?: unknown }).kind));

/**
 * Kinds `rename_object` offers on fewer surfaces than the tool itself. A
 * kind not listed is offered wherever the tool is.
 */
const RENAME_KIND_SURFACES: Readonly<Record<string, readonly AgentSurface[]>> =
  {
    connection: ["external-mcp"],
  };

/** Whether `rename_object` may rename this kind on this surface. */
export function renameKindAllowedOn(
  kind: string,
  surface: AgentSurface,
): boolean {
  return (RENAME_KIND_SURFACES[kind] ?? ALL_AGENT_SURFACES).includes(surface);
}

export const RENAME_CAPABILITIES = [
  define({
    name: "rename_object",
    pack: "rename",
    risk: "write",
    inputConditionalGrants: [
      {
        grant: "warehouse-write",
        behavior: "renaming a dbt job",
        appliesTo: kindIs("dbt_job"),
      },
      {
        grant: "git-write",
        behavior: "renaming a skill or a workspace connector",
        appliesTo: kindIs("skill", "connector"),
      },
      {
        grant: "connections-manage",
        behavior: "renaming a connection",
        appliesTo: kindIs("connection"),
      },
    ],
    surfaces: ALL_AGENT_SURFACES,
    resultKind: "artifact",
  }),
] as const satisfies readonly RenameCapabilityDefinition[];
