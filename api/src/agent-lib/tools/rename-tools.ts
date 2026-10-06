/**
 * `rename_object` — rename anything in the workspace without breaking what
 * pointed at it (see api/src/rename/types.ts for the contract).
 *
 * One tool for every kind on purpose: the rules are the same everywhere
 * (old names keep resolving, ids never change), and an agent that learns
 * them once should not have to find ten tools.
 */
import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { workspaceService } from "../../services/workspace.service";
import { RENAME_HANDLERS, renameObject } from "../../rename/registry";
import { RENAME_KINDS, RenameError } from "../../rename/types";

const KIND_LINES = RENAME_KINDS.map(
  kind => `- ${kind}: ${RENAME_HANDLERS[kind].describe}`,
).join("\n");

export function createRenameTools(
  workspaceId: string,
  userId?: string,
): ToolSet {
  return {
    rename_object: tool({
      description:
        "Rename a workspace object gracefully: its id never changes, and every old link, ref and name keeps working (the old name is recorded as an alias that resolves to the object). Use this instead of moving files by hand — a hand rename of a flow, dbt job, skill or connector file can lose history.\n\n" +
        "`title` changes the display name; `slug` changes the identifier/URL. Per kind:\n" +
        KIND_LINES,
      inputSchema: z.object({
        kind: z.enum(RENAME_KINDS),
        ref: z
          .string()
          .min(1)
          .describe(
            "The object: its id, current name/slug/path, or an old name.",
          ),
        title: z.string().min(1).max(200).optional(),
        slug: z.string().min(1).max(500).optional(),
        options: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("Kind-specific options; see the kind's line above."),
      }),
      execute: async ({ kind, ref, title, slug, options }) => {
        try {
          const role = userId
            ? (await workspaceService.getMember(workspaceId, userId))?.role
            : undefined;
          const result = await renameObject(
            { workspaceId, userId, role },
            kind,
            { ref, title, slug, options },
          );
          return { success: true, ...result };
        } catch (error) {
          return {
            success: false,
            error:
              error instanceof RenameError || error instanceof Error
                ? error.message
                : String(error),
          };
        }
      },
    }),
  };
}
