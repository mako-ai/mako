/**
 * `rename_object` — rename a workspace object without changing its id (see
 * api/src/rename/types.ts for the contract).
 *
 * One tool for every kind on purpose: the rules are the same everywhere,
 * and an agent that learns them once should not have to find ten tools. It
 * offers the kinds that have a handler (rename/registry.ts) and that this
 * surface may rename (`renameKindAllowedOn`); with none, there is no tool.
 * Per-kind grants are in @mako/agent-tools (rename-capabilities.ts), and
 * each handler checks the caller's live role and access itself.
 */
import { renameKindAllowedOn, type AgentSurface } from "@mako/agent-tools";
import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { workspaceService } from "../../services/workspace.service";
import {
  RENAME_HANDLERS,
  renameObject,
  supportedRenameKinds,
} from "../../rename/registry";
import { RenameError, type RenameKind } from "../../rename/types";

export function createRenameTools(
  workspaceId: string,
  userId?: string,
  options: { surface?: AgentSurface } = {},
): ToolSet {
  const surface = options.surface ?? "external-mcp";
  const kinds = supportedRenameKinds().filter(kind =>
    renameKindAllowedOn(kind, surface),
  );
  if (kinds.length === 0) return {};
  const kindLines = kinds
    .map(kind => `- ${kind}: ${RENAME_HANDLERS[kind]?.describe ?? ""}`)
    .join("\n");

  return {
    rename_object: tool({
      description:
        "Rename a workspace object. Its id never changes, so everything that references the id keeps working. What happens to references by the OLD NAME depends on the kind and is stated on its line below; the result's `warnings` say what to check. Use this instead of editing or moving files by hand.\n\n" +
        "`ref` is the object's id or current name. `title` changes the display name; `slug` changes the identifier a kind is addressed by. Per kind:\n" +
        kindLines,
      inputSchema: z.object({
        kind: z.enum(kinds as [RenameKind, ...RenameKind[]]),
        ref: z
          .string()
          .min(1)
          .describe(
            "The object: its id, current name/slug/path, or an old name.",
          ),
        title: z.string().min(1).max(1000).optional(),
        slug: z.string().min(1).max(500).optional(),
        options: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("Kind-specific options; see the kind's line above."),
      }),
      execute: async ({ kind, ref, title, slug, options: kindOptions }) => {
        try {
          const role = userId
            ? (await workspaceService.getMember(workspaceId, userId))?.role
            : undefined;
          const result = await renameObject(
            { workspaceId, userId, role },
            kind,
            { ref, title, slug, options: kindOptions },
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
