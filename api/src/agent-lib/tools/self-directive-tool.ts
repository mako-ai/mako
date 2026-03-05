import { z } from "zod";
import { Workspace } from "../../database/workspace-schema";

const MAX_SELF_DIRECTIVE_LENGTH = 10000;

function literalReplace(
  source: string,
  search: string,
  replacement: string,
): string {
  const idx = source.indexOf(search);
  if (idx === -1) return source;
  return source.slice(0, idx) + replacement + source.slice(idx + search.length);
}

const updateSelfDirectiveSchema = z
  .object({
    operation: z
      .enum([
        "set",
        "append",
        "prepend",
        "find_and_replace",
        "insert_after",
        "delete_section",
      ])
      .describe(
        "set: overwrite entire self-directive. append: add to end. prepend: add to beginning. find_and_replace: replace a specific section. insert_after: insert content after a marker. delete_section: remove a specific section.",
      ),
    content: z
      .string()
      .max(MAX_SELF_DIRECTIVE_LENGTH)
      .optional()
      .describe(
        "The content to write. Required for set, append, prepend, insert_after.",
      ),
    find: z
      .string()
      .optional()
      .describe(
        "The exact text to locate. Required for find_and_replace and delete_section.",
      ),
    replace: z
      .string()
      .optional()
      .describe("The replacement text. Required for find_and_replace."),
    after: z
      .string()
      .optional()
      .describe("The anchor text to insert after. Required for insert_after."),
  })
  .superRefine((data, ctx) => {
    const { operation, content, find, replace, after } = data;
    if (
      (operation === "set" ||
        operation === "append" ||
        operation === "prepend") &&
      !content
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `'content' is required for '${operation}' operation`,
        path: ["content"],
      });
    }
    if (operation === "find_and_replace") {
      if (!find) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "'find' is required for 'find_and_replace' operation",
          path: ["find"],
        });
      }
      if (replace === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "'replace' is required for 'find_and_replace' operation",
          path: ["replace"],
        });
      }
    }
    if (operation === "insert_after") {
      if (!after) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "'after' is required for 'insert_after' operation",
          path: ["after"],
        });
      }
      if (!content) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "'content' is required for 'insert_after' operation",
          path: ["content"],
        });
      }
    }
    if (operation === "delete_section" && !find) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "'find' is required for 'delete_section' operation",
        path: ["find"],
      });
    }
  });

const readSelfDirectiveSchema = z.object({});

type UpdateInput = z.infer<typeof updateSelfDirectiveSchema>;

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
      description: [
        "Update the self-directive (persistent workspace-scoped memory). Operations:",
        "- set: Overwrite entire content. Use for initial setup or full rewrites.",
        "- append: Add content to end (newline-separated). Good for adding new rules.",
        "- prepend: Add content to beginning (newline-separated). Good for high-priority items.",
        "- find_and_replace: Replace a specific section. Provide 'find' (exact text to match) and 'replace' (new text).",
        "- insert_after: Insert content after a specific line/section. Provide 'after' (anchor text) and 'content'.",
        "- delete_section: Remove a specific section. Provide 'find' (exact text to remove).",
        "",
        "Always read_self_directive first to see what exists before modifying.",
      ].join("\n"),
      inputSchema: updateSelfDirectiveSchema,
      execute: async (input: UpdateInput) => {
        const { operation, content, find, replace, after } = input;

        const ws =
          await Workspace.findById(workspaceId).select("selfDirective");
        if (!ws) return { success: false, error: "Workspace not found" };

        const current = ws.selfDirective || "";
        let newValue: string;

        switch (operation) {
          case "set":
            newValue = content!;
            break;

          case "append":
            newValue = current ? current + "\n" + content! : content!;
            break;

          case "prepend":
            newValue = current ? content! + "\n" + current : content!;
            break;

          case "find_and_replace":
            if (!current.includes(find!)) {
              return {
                success: false,
                error: `Text not found in self-directive: "${find!.slice(0, 80)}"`,
              };
            }
            newValue = literalReplace(current, find!, replace!);
            break;

          case "insert_after":
            if (!current.includes(after!)) {
              return {
                success: false,
                error: `Anchor text not found in self-directive: "${after!.slice(0, 80)}"`,
              };
            }
            newValue = literalReplace(
              current,
              after!,
              after! + "\n" + content!,
            );
            break;

          case "delete_section":
            if (!current.includes(find!)) {
              return {
                success: false,
                error: `Text not found in self-directive: "${find!.slice(0, 80)}"`,
              };
            }
            newValue = literalReplace(current, find!, "")
              .replace(/\n{3,}/g, "\n\n")
              .trim();
            break;

          default:
            return { success: false, error: `Unknown operation: ${operation}` };
        }

        if (newValue.length > MAX_SELF_DIRECTIVE_LENGTH) {
          return {
            success: false,
            error: `Self-directive would exceed the ${MAX_SELF_DIRECTIVE_LENGTH} character limit (result: ${newValue.length} chars). Use 'set' to rewrite more concisely, or 'delete_section' to remove content first.`,
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
