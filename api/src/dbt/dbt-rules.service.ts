/**
 * `.makorules` — user-authored rules the dbt agent obeys.
 *
 * A dbt project may ship a markdown rules file at its root describing how the
 * team wants SQL written (naming, CTE style, required tests, banned patterns).
 * It is an ordinary working-tree file, so it syncs from GitHub, commits through
 * the dbt git tools, and is editable in the Transforms explorer. Because reads
 * go through the working tree, a user's UNCOMMITTED draft governs their own
 * agent turns — edit the rules, re-prompt, no commit in between.
 *
 * The rendered block is injected into the dynamic (non-cached) system message
 * by agent.routes.ts; see dbt-rules-turn.service.ts for turn-level resolution.
 */

import type { IDbtProject } from "../database/workspace-schema";
import { readWorkingFile } from "./dbt-working-tree.service";

/** Recognized filenames, highest precedence first. */
export const DBT_RULES_PATHS = [".makorules.md", ".makorules"] as const;

/** ~4k tokens. Rules past this are cut, with the cut declared in the prompt. */
export const DBT_RULES_MAX_CHARS = 16_000;

export interface DbtRules {
  /** Which of DBT_RULES_PATHS was found. */
  path: string;
  /** File contents, cut to DBT_RULES_MAX_CHARS. */
  contents: string;
  truncated: boolean;
}

/**
 * Read a project's rules file from `userId`'s working tree. Returns null when
 * no recognized file exists or every candidate is blank.
 */
export async function resolveDbtRules(
  project: IDbtProject,
  userId: string | undefined,
): Promise<DbtRules | null> {
  // Drafts are keyed by user; agent turns without a session act as "agent",
  // matching createDbtServerTools.
  const actingUserId = userId ?? "agent";

  for (const path of DBT_RULES_PATHS) {
    const file = await readWorkingFile(project, actingUserId, path);
    const contents = file?.content ?? "";
    // A blank file is not a statement of intent — keep looking.
    if (contents.trim().length === 0) continue;

    const truncated = contents.length > DBT_RULES_MAX_CHARS;
    return {
      path,
      contents: truncated ? contents.slice(0, DBT_RULES_MAX_CHARS) : contents,
      truncated,
    };
  }
  return null;
}

/** Render the system-prompt block for a resolved rules file. */
export function renderDbtRulesBlock(
  rules: DbtRules,
  projectName: string,
): string {
  const lines = [
    `### Project rules — \`${rules.path}\``,
    "",
    `The dbt project "${projectName}" ships a rules file written by its ` +
      "maintainers. Treat every line of it as BINDING for the SQL, models, " +
      "tests, and YAML you write in this project.",
    "",
    "Precedence, highest first: explicit user instructions in this " +
      `conversation > these project rules (\`${rules.path}\`) > workspace ` +
      "instructions > the `dbt` system skill > Mako's built-in defaults.",
    "",
    "When a rule blocks what the user asked for, say so and cite " +
      `\`${rules.path}\` — never silently ignore either one.`,
    "",
    "<project_rules>",
    rules.contents,
    "</project_rules>",
  ];

  if (rules.truncated) {
    lines.push(
      "",
      `[\`${rules.path}\` was truncated at ${DBT_RULES_MAX_CHARS} characters — ` +
        "read the full file with `read_dbt_file` if you need the rest.]",
    );
  }

  return lines.join("\n");
}
