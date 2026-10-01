import { tool } from "ai";
import { z } from "zod";
import { saveSkill, skillExists } from "../../services/skills.service";
import {
  commitWorkspaceSelfDirective,
  readWorkspaceSelfDirectiveFile,
} from "../../apps/workspace-prompt";
import { RepoRequiredError } from "../../apps/config";

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
    `Free space now: use 'archive_section' to move detailed sections into ` +
    `workspace skills (retrieved on demand — nothing is lost), and 'set' to ` +
    `merge overlapping rules and drop stale notes. Keep the directive a terse ` +
    `index of durable rules — otherwise future updates will start failing at the limit.`
  );
}

/**
 * One-line pointer left behind when a section is archived to a skill, so the
 * always-loaded directive still tells the agent where the detail lives.
 */
export function buildSkillPointer(skillName: string, loadWhen: string): string {
  const summary =
    loadWhen.length > 100 ? loadWhen.slice(0, 97) + "..." : loadWhen;
  return `- → skill '${skillName}': ${summary}`;
}

export interface ArchiveSectionInput {
  find: string;
  skillName: string;
  loadWhen: string;
  keepPointer: boolean;
}

export type ArchiveSectionPlan =
  | { ok: true; section: string; newValue: string }
  | { ok: false; error: string };

/**
 * Pure planning half of 'archive_section': locate the section and compute the
 * post-eviction directive (section replaced by a short pointer, or removed).
 * The impure half — saving the section as a workspace skill — happens in the
 * tool, AFTER this plan succeeds and BEFORE the directive is rewritten, so a
 * failure at any step never loses the section's content.
 */
export function planArchiveSection(
  current: string,
  input: ArchiveSectionInput,
): ArchiveSectionPlan {
  const section = input.find;
  if (!current.includes(section)) {
    return {
      ok: false,
      error: `Text not found in self-directive: "${section.slice(0, 80)}"`,
    };
  }
  const replacement = input.keepPointer
    ? buildSkillPointer(input.skillName, input.loadWhen)
    : "";
  const newValue = literalReplace(current, section, replacement)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (newValue.length > MAX_SELF_DIRECTIVE_LENGTH) {
    return {
      ok: false,
      error:
        `Directive would still be ${newValue.length}/${MAX_SELF_DIRECTIVE_LENGTH} ` +
        `characters after archiving this section — archive a larger section.`,
    };
  }
  return { ok: true, section: section.trim(), newValue };
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
        `Do NOT retry the same content. Recover in one step: use ` +
        `'archive_section' to evict a detailed section into a workspace skill ` +
        `(retrieved on demand — nothing is lost), or 'set' with a compacted ` +
        `rewrite of the FULL directive that includes your new addition.`,
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
        "archive_section",
      ])
      .describe(
        "set: overwrite entire self-directive. append: add to end. prepend: add to beginning. find_and_replace: replace a specific section. insert_after: insert content after a marker. delete_section: remove a specific section. archive_section: move a section into a workspace skill (retrieved on demand) and leave a one-line pointer — the way to free space without losing knowledge.",
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
        "The exact text to locate. Required for find_and_replace, delete_section, and archive_section (where it is the full section text to move into the skill).",
      ),
    replace: z
      .string()
      .optional()
      .describe("The replacement text. Required for find_and_replace."),
    after: z
      .string()
      .optional()
      .describe("The anchor text to insert after. Required for insert_after."),
    skill_name: z
      .string()
      .max(80)
      .regex(/^[a-z0-9_]+$/, "skill_name must be lowercase snake_case")
      .optional()
      .describe(
        "Name for the new workspace skill. Required for archive_section. Lowercase snake_case; must not already exist (archiving never overwrites a skill).",
      ),
    load_when: z
      .string()
      .max(500)
      .optional()
      .describe(
        "Retrieval trigger for the archived skill (1-2 sentences describing when it should load). Required for archive_section.",
      ),
    entities: z
      .array(z.string())
      .optional()
      .describe(
        "Optional retrieval triggers for the archived skill (table names, business concepts, synonyms). Only used by archive_section.",
      ),
    keep_pointer: z
      .boolean()
      .optional()
      .describe(
        "archive_section only: leave a one-line pointer to the skill where the section was (default true).",
      ),
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
    if (operation === "archive_section") {
      for (const [field, value] of [
        ["find", find],
        ["skill_name", data.skill_name],
        ["load_when", data.load_when],
      ] as const) {
        if (!value) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `'${field}' is required for 'archive_section' operation`,
            path: [field],
          });
        }
      }
    }
  });

const readSelfDirectiveSchema = z.object({});

export function createSelfDirectiveTools(workspaceId: string, userId?: string) {
  const authorId = userId && userId.length > 0 ? userId : "agent";

  return {
    read_self_directive: tool({
      description: `Read the current self-directive -- the workspace-specific rules and knowledge you've learned (${MAX_SELF_DIRECTIVE_LENGTH} character capacity; the result reports remaining space). Check this before updating to avoid duplicates.`,
      inputSchema: readSelfDirectiveSchema,
      execute: async () => {
        try {
          const content =
            (await readWorkspaceSelfDirectiveFile(workspaceId)) ?? "";
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
        "- archive_section: Move a section into a workspace skill and leave a one-line pointer. Provide 'find' (exact section text), 'skill_name' (snake_case), 'load_when' (retrieval trigger), optionally 'entities'. The skill is retrieved on demand in future sessions, so nothing is lost.",
        "",
        "Always read_self_directive first to see what exists before modifying.",
        "The directive is ALWAYS loaded into your prompt — keep it a terse index of durable rules. Detailed or situational knowledge (long playbooks, per-table quirks, worked examples) belongs in skills: archive_section moves it there. When the result reports the directive is nearly full, archive detail first, then compact what remains with 'set'.",
      ].join("\n"),
      inputSchema: updateSelfDirectiveSchema,
      execute: async input => {
        try {
          const current =
            (await readWorkspaceSelfDirectiveFile(workspaceId)) ?? "";
          const { operation, content, find, replace, after } = input;

          if (operation === "archive_section") {
            const { skill_name, load_when } = input;
            // superRefine enforces these; runtime guard narrows for TS.
            if (!find || !skill_name || !load_when) {
              return {
                success: false,
                error:
                  "'find', 'skill_name', and 'load_when' are required for 'archive_section' operation",
              };
            }

            const plan = planArchiveSection(current, {
              find,
              skillName: skill_name,
              loadWhen: load_when,
              keepPointer: input.keep_pointer ?? true,
            });
            if (!plan.ok) return { success: false, error: plan.error };

            if (await skillExists(workspaceId, skill_name)) {
              return {
                success: false,
                error:
                  `Skill '${skill_name}' already exists — archiving never overwrites a skill. ` +
                  `Pick a different name, or merge this section into the existing skill with ` +
                  `save_skill and then remove it here with delete_section.`,
              };
            }

            // Skill first, directive second: a failure between the two leaves
            // the section in both places (recoverable), never in neither.
            const saved = await saveSkill(
              workspaceId,
              {
                name: skill_name,
                loadWhen: load_when,
                body: plan.section,
                entities: input.entities,
              },
              authorId,
            );
            if (!saved.success) {
              return {
                success: false,
                error: `Could not archive to skill: ${saved.error} Self-directive unchanged.`,
              };
            }

            try {
              await commitWorkspaceSelfDirective(
                workspaceId,
                plan.newValue,
                authorId,
              );
            } catch (error) {
              return {
                success: false,
                error:
                  `Section was saved to skill '${skill_name}', but removing it from the ` +
                  `self-directive failed (${error instanceof Error ? error.message : "unknown error"}). ` +
                  `Retry with 'delete_section' to remove the now-archived text.`,
              };
            }

            const warning = selfDirectiveCompactionWarning(
              plan.newValue.length,
            );
            return {
              success: true,
              archivedToSkill: skill_name,
              archivedChars: plan.section.length,
              ...selfDirectiveUsage(plan.newValue.length),
              ...(warning ? { warning } : {}),
            };
          }

          const result = applySelfDirectiveOperation(current, {
            operation,
            content,
            find,
            replace,
            after,
          });
          if (!result.ok) return { success: false, error: result.error };

          await commitWorkspaceSelfDirective(
            workspaceId,
            result.value,
            authorId,
          );

          const warning = selfDirectiveCompactionWarning(result.value.length);
          return {
            success: true,
            ...selfDirectiveUsage(result.value.length),
            ...(warning ? { warning } : {}),
          };
        } catch (error) {
          if (error instanceof RepoRequiredError) {
            return {
              success: false,
              error: error.message,
            };
          }
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
