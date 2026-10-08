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
 *     code AND re-points every connection of that connector, so neither
 *     rides on the implicit authoring authority every external key holds;
 *   - apps, consoles, notebooks, dashboards, flows, dbt files, connection
 *     display names: no extra grant — the same authority app_move_app,
 *     modify_console and edit_dbt_file already have.
 *
 * The services re-check the caller's live role and per-object ACL on every
 * call; these grants are the agent-surface layer on top.
 */
import { ALL_AGENT_SURFACES, type AgentCapabilityDefinition } from "./types";

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
    ],
    surfaces: ALL_AGENT_SURFACES,
    resultKind: "artifact",
  }),
] as const satisfies readonly RenameCapabilityDefinition[];
