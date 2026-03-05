import { z } from "zod";
import { Workspace } from "../../database/workspace-schema";

const updateSelfDirectiveSchema = z.object({
  operation: z
    .enum(["append", "replace"])
    .describe(
      "append: add to end of self-directive. replace: overwrite entire self-directive.",
    ),
  content: z
    .string()
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
        const ws = await Workspace.findById(workspaceId);
        if (!ws) return { success: false, error: "Workspace not found" };

        if (operation === "replace") {
          ws.selfDirective = content;
        } else {
          ws.selfDirective = ws.selfDirective
            ? ws.selfDirective + "\n" + content
            : content;
        }
        await ws.save();
        return { success: true, length: (ws.selfDirective || "").length };
      },
    },
  };
}
