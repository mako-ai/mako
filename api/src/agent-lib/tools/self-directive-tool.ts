import { tool } from "ai";
import { z } from "zod";
import { Workspace } from "../../database/workspace-schema";

export const MAX_SELF_DIRECTIVE_LENGTH = 10000;

/**
 * Once usage crosses this fraction of the limit, successful updates carry a
 * warning nudging the agent to compact — so it rewrites proactively instead
 * of discovering the cap via a failed update at the start of every session.
 */
const COMPACTION_WARNING_RATIO = 0.8;

function literalReplace(
  source: string,
  search: string,
  replacement: string,
): string {
  const idx = source.indexOf(search);
  if (idx === -1) return source;
  return source.slice(0, idx) + replacement + source.slice(idx + search.length);
}

export function selfDirectiveUsage(length: number) {
  return {
    length,
    limit: MAX_SELF_DIRECTIVE_LENGTH,
    remaining: Math.max(0, MAX_SELF_DIRECTIVE_LENGTH - length),
  };
}

export function selfDirectiveCompactionWarning(
  length: number,
): string | undefined {
  if (length < MAX_SELF_DIRECTIVE_LENGTH * COMPACTION_WARNING_RATIO) {
    return undefined;
  }
  const percent = Math.round((length / MAX_SELF_DIRECTIVE_LENGTH) * 100);
  return (
    `Self-directive is ${length}/${MAX_SELF_DIRECTIVE_LENGTH} characters (${percent}% full). ` +
    `Compact it now with 'set': merge overlapping rules, drop stale or one-off notes, ` +
    `and keep only durable knowledge — otherwise future updates will start failing at the limit.`
  );
}

export interface SelfDirectiveOperationInput {
  operation:
    | "set"
    | "append"
    | "prepend"
    | "find_and_replace"
    | "insert_after"
    | "delete_section";
  content?: string;
  find?: string;
  replace?: string;
  after?: string;
}

export type SelfDirectiveOperationResult =
  | { ok: true; value: string }
  | { ok: false; error: string };

/**
 * Pure application of an update operation to the current directive text.
 * Enforces the character limit; returns an actionable error on overflow so
 * the agent recovers in one step instead of retrying the same content.
 */
export function applySelfDirectiveOperation(
  current: string,
  input: SelfDirectiveOperationInput,
): SelfDirectiveOperationResult {
  const { operation, content, find, replace, after } = input;

  const missing = (field: string): SelfDirectiveOperationResult => ({
    ok: false,
    error: `'${field}' is required for '${operation}' operation`,
  });

  let newValue: string;

  switch (operation) {
    case "set": {
      if (content === undefined) return missing("content");
      newValue = content;
      break;
    }

    case "append": {
      if (content === undefined) return missing("content");
      newValue = current ? current + "\n" + content : content;
      break;
    }

    case "prepend": {
      if (content === undefined) return missing("content");
      newValue = current ? content + "\n" + current : content;
      break;
    }

    case "find_and_replace": {
      if (find === undefined) return missing("find");
      if (replace === undefined) return missing("replace");
      if (!current.includes(find)) {
        return {
          ok: false,
          error: `Text not found in self-directive: "${find.slice(0, 80)}"`,
        };
      }
      newValue = literalReplace(current, find, replace);
      break;
    }

    case "insert_after": {
      if (after === undefined) return missing("after");
      if (content === undefined) return missing("content");
      if (!current.includes(after)) {
        return {
          ok: false,
          error: `Anchor text not found in self-directive: "${after.slice(0, 80)}"`,
        };
      }
      newValue = literalReplace(current, after, after + "\n" + content);
      break;
    }

    case "delete_section": {
      if (find === undefined) return missing("find");
      if (!current.includes(find)) {
        return {
          ok: false,
          error: `Text not found in self-directive: "${find.slice(0, 80)}"`,
        };
      }
      newValue = literalReplace(current, find, "")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
      break;
    }

    default:
      return { ok: false, error: `Unknown operation: ${String(operation)}` };
  }

  if (newValue.length > MAX_SELF_DIRECTIVE_LENGTH) {
    const over = newValue.length - MAX_SELF_DIRECTIVE_LENGTH;
    const { remaining } = selfDirectiveUsage(current.length);
    return {
      ok: false,
      error:
        `Update rejected: result would be ${newValue.length} characters, ` +
        `${over} over the ${MAX_SELF_DIRECTIVE_LENGTH} limit ` +
        `(current: ${current.length} chars, only ${remaining} free). ` +
        `Do NOT retry the same content. Instead, use 'set' with a compacted ` +
        `rewrite of the FULL directive — merge overlapping rules, drop stale ` +
        `or one-off notes, include your new addition — kept under the limit.`,
    };
  }

  return { ok: true, value: newValue };
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

export function createSelfDirectiveTools(workspaceId: string) {
  return {
    read_self_directive: tool({
      description: `Read the current self-directive -- the workspace-specific rules and knowledge you've learned (${MAX_SELF_DIRECTIVE_LENGTH} character capacity; the result reports remaining space). Check this before updating to avoid duplicates.`,
      inputSchema: readSelfDirectiveSchema,
      execute: async () => {
        try {
          const ws =
            await Workspace.findById(workspaceId).select("selfDirective");
          const content = ws?.selfDirective || "";
          return {
            content: content || "(empty -- no self-directive set yet)",
            ...selfDirectiveUsage(content.length),
          };
        } catch (error) {
          return {
            success: false,
            error:
              error instanceof Error
                ? error.message
                : "Failed to read self-directive",
          };
        }
      },
    }),
    update_self_directive: tool({
      description: [
        `Update the self-directive (persistent workspace-scoped memory, ${MAX_SELF_DIRECTIVE_LENGTH} character capacity). Operations:`,
        "- set: Overwrite entire content. Use for initial setup or full rewrites.",
        "- append: Add content to end (newline-separated). Good for adding new rules.",
        "- prepend: Add content to beginning (newline-separated). Good for high-priority items.",
        "- find_and_replace: Replace a specific section. Provide 'find' (exact text to match) and 'replace' (new text).",
        "- insert_after: Insert content after a specific line/section. Provide 'after' (anchor text) and 'content'.",
        "- delete_section: Remove a specific section. Provide 'find' (exact text to remove).",
        "",
        "Always read_self_directive first to see what exists before modifying.",
        "Keep entries terse. If the result reports it is nearly full, compact it with 'set' (merge overlapping rules, drop stale notes) instead of appending more.",
      ].join("\n"),
      inputSchema: updateSelfDirectiveSchema,
      execute: async input => {
        try {
          const ws =
            await Workspace.findById(workspaceId).select("selfDirective");
          if (!ws) return { success: false, error: "Workspace not found" };

          const result = applySelfDirectiveOperation(
            ws.selfDirective || "",
            input,
          );
          if (!result.ok) return { success: false, error: result.error };

          await Workspace.findByIdAndUpdate(workspaceId, {
            $set: { selfDirective: result.value },
          });

          const warning = selfDirectiveCompactionWarning(result.value.length);
          return {
            success: true,
            ...selfDirectiveUsage(result.value.length),
            ...(warning ? { warning } : {}),
          };
        } catch (error) {
          return {
            success: false,
            error:
              error instanceof Error
                ? error.message
                : "Failed to update self-directive",
          };
        }
      },
    }),
  };
}
