import { z } from "zod";
import { Workspace } from "../../database/workspace-schema";

const MAX_SELF_DIRECTIVE_LENGTH = 10000;

const updateSelfDirectiveSchema = z.object({
  operation: z
    .enum(["append", "replace"])
    .describe(
      "append: add to end of self-directive. replace: overwrite entire self-directive.",
    ),
  content: z
    .string()
    .max(MAX_SELF_DIRECTIVE_LENGTH)
    .describe("The content to append or replace with. Markdown supported."),
});

const readSelfDirectiveSchema = z.object({});

export function createSelfDirectiveTools(workspaceId: string) {
  return {
    read_self_directive: {
      description:
        "Read the current self-directive -- the workspace-specific rules and knowledge you've learned. Check this before updating to avoid duplicates.",
      inputSchema: readSelfDirectiveSchema,
      execute: async () => {
        const ws =
          await Workspace.findById(workspaceId).select("selfDirective");
        return {
          content: ws?.selfDirective || "(empty -- no self-directive set yet)",
        };
      },
    },
    update_self_directive: {
      description:
        "Update your self-directive with learned rules, schema quirks, or user preferences. Use 'append' to add new knowledge, 'replace' to rewrite entirely. This persists across all future conversations.",
      inputSchema: updateSelfDirectiveSchema,
      execute: async ({
        operation,
        content,
      }: {
        operation: "append" | "replace";
        content: string;
      }) => {
        if (!content) return { success: false, error: "content is required" };

        if (operation === "replace") {
          await Workspace.findByIdAndUpdate(workspaceId, {
            $set: { selfDirective: content },
          });
          return { success: true, length: content.length };
        }

        const ws =
          await Workspace.findById(workspaceId).select("selfDirective");
        if (!ws) return { success: false, error: "Workspace not found" };

        const newValue = ws.selfDirective
          ? ws.selfDirective + "\n" + content
          : content;

        if (newValue.length > MAX_SELF_DIRECTIVE_LENGTH) {
          return {
            success: false,
            error: `Self-directive would exceed the ${MAX_SELF_DIRECTIVE_LENGTH} character limit (current: ${(ws.selfDirective || "").length}, incoming: ${content.length}). Use 'replace' to rewrite it more concisely.`,
          };
        }

        await Workspace.findByIdAndUpdate(workspaceId, {
          $set: { selfDirective: newValue },
        });
        return { success: true, length: newValue.length };
      },
    },
  };
}
