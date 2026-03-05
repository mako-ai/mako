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
        if (operation === "replace") {
          const ws = await Workspace.findByIdAndUpdate(
            workspaceId,
            { $set: { selfDirective: content } },
            { new: true, select: "selfDirective" },
          );
          if (!ws) return { success: false, error: "Workspace not found" };
          return { success: true, length: (ws.selfDirective || "").length };
        }

        const current =
          await Workspace.findById(workspaceId).select("selfDirective");
        if (!current) return { success: false, error: "Workspace not found" };

        const currentLen = (current.selfDirective || "").length;
        const newLen = currentLen + (currentLen > 0 ? 1 : 0) + content.length;
        if (newLen > MAX_SELF_DIRECTIVE_LENGTH) {
          return {
            success: false,
            error: `Self-directive would exceed the ${MAX_SELF_DIRECTIVE_LENGTH} character limit (current: ${currentLen}, incoming: ${content.length}). Use 'replace' to rewrite it more concisely.`,
          };
        }

        const safeContent = { $literal: content };
        const ws = await Workspace.findOneAndUpdate(
          {
            _id: workspaceId,
            $expr: {
              $lte: [
                {
                  $add: [
                    { $strLenCP: { $ifNull: ["$selfDirective", ""] } },
                    content.length + 1,
                  ],
                },
                MAX_SELF_DIRECTIVE_LENGTH,
              ],
            },
          },
          [
            {
              $set: {
                selfDirective: {
                  $cond: {
                    if: {
                      $and: [
                        { $ne: ["$selfDirective", ""] },
                        { $ne: ["$selfDirective", null] },
                      ],
                    },
                    then: { $concat: ["$selfDirective", "\n", safeContent] },
                    else: safeContent,
                  },
                },
              },
            },
          ],
          { new: true, projection: { selfDirective: 1 } },
        );
        if (!ws) {
          const exists = await Workspace.exists({ _id: workspaceId });
          if (!exists) return { success: false, error: "Workspace not found" };
          return {
            success: false,
            error: `Self-directive would exceed the ${MAX_SELF_DIRECTIVE_LENGTH} character limit. Use 'replace' to rewrite it more concisely.`,
          };
        }
        return { success: true, length: (ws.selfDirective || "").length };
      },
    },
  };
}
