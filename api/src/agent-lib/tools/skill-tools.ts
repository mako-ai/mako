/**
 * Skill tools — agent-side CRUD + search for the skills system (issue #365).
 *
 * Tools:
 *   - save_skill / delete_skill     workspace skill writes (in-product)
 *   - list_skills                   compact index (workspace + system)
 *   - get_relevant_skills           same retrieval as pre-turn auto-inject
 *   - load_skill                    explicit load by name
 *   - read_skill_resource           a skill's extra files (read only)
 *   - search_skills                 free-text fallback
 *
 * The in-product agent also gets the index + top-k bodies injected into the
 * system prompt before each turn. MCP clients do not — they call list_skills /
 * get_relevant_skills instead.
 *
 * Every read that returns a skill is counted per day (skill-usage.service),
 * after the result is built and without waiting for the write.
 */

import { tool } from "ai";
import { z } from "zod";
import {
  deleteSkill,
  findInvalidSkillsMatching,
  invalidSkillsNotice,
  loadSkill,
  readSkillResource,
  retrieveRelevantSkills,
  saveSkill,
  searchSkills,
  skillUsageForIndex,
} from "../../services/skills.service";
import {
  recordSkillUsage,
  skillScopeFromId,
  type SkillUsageSource,
} from "../../services/skill-usage.service";
import { SKILL_NAME_RE, SKILL_NAME_RULE } from "../../apps/skill-files";
import { loadSkillCatalog } from "../../apps/workspace-skills.service";

const saveSkillSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(80)
    .regex(SKILL_NAME_RE, `name must be ${SKILL_NAME_RULE}`)
    .describe(
      "Unique skill name: lowercase letters, digits, '-' or '_' (e.g. `revenue-walkthrough`). Stable identifier — reuse the same name to overwrite an existing skill; previous versions remain recoverable from git history.",
    ),
  loadWhen: z
    .string()
    .min(1)
    .max(300)
    .describe(
      "One trigger line: when to load this skill. It is shown in the agent's prompt on every turn as the skill's index entry, e.g. 'building a sales report or answering \"who are the best salespeople\"'.",
    ),
  body: z
    .string()
    .min(1)
    .max(20000)
    .describe(
      "The full playbook content. Mix schema facts, gotchas, query patterns, IDs — whatever the agent will need next time the trigger fires. Prefer compact bullet points over prose.",
    ),
  entities: z
    .array(z.string())
    .optional()
    .describe(
      "Optional keywords (table names, columns, business concepts) that `search_skills` matches on. Include synonyms (e.g. 'revenue' if the body talks about 'MRR').",
    ),
  pinned: z
    .boolean()
    .optional()
    .describe(
      "Pin the skill: a budgeted body excerpt rides in every prompt. Reserve for the two or three skills every turn needs (glossaries, warehouse maps). Omit to keep the current setting.",
    ),
});

const deleteSkillSchema = z.object({
  name: z
    .string()
    .min(1)
    .describe(
      "Skill name to delete. Removes the current file; git history retains prior versions.",
    ),
});

const loadSkillSchema = z.object({
  name: z
    .string()
    .min(1)
    .describe(
      "Skill name to load. Use this as soon as a skill in the index matches what you are about to do.",
    ),
});

const searchSkillsSchema = z.object({
  query: z
    .string()
    .min(1)
    .describe(
      "Keywords to match against skill names, descriptions, entities and bodies. Use this when no index line rang a bell.",
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(20)
    .optional()
    .describe("Max results (default 5)."),
});

const readSkillResourceSchema = z.object({
  name: z
    .string()
    .min(1)
    .describe(
      "Name of the skill that owns the file, workspace or `[system]`, e.g. `apps`.",
    ),
  path: z
    .string()
    .min(1)
    .describe(
      "Path relative to the skill folder, exactly as `load_skill` lists it under `resources`, e.g. `references/charting.md` or `scripts/backfill.sql`.",
    ),
});

const listSkillsSchema = z.object({});

const getRelevantSkillsSchema = z.object({
  query: z
    .string()
    .min(1)
    .describe(
      "Keywords describing the task; the best-matching skills come back with their full bodies.",
    ),
});

export function createSkillTools(
  workspaceId: string,
  userId?: string,
  options: {
    /** Who these tools serve, for the usage counts. Default: the in-product agent. */
    source?: SkillUsageSource;
  } = {},
) {
  const authorId = userId && userId.length > 0 ? userId : "agent";
  const source: SkillUsageSource = options.source ?? "agent";
  /** A hidden skill file the query named, as extra fields on a search result. */
  const hiddenMatches = async (query: string) => {
    const hidden = await findInvalidSkillsMatching(workspaceId, query);
    if (hidden.length === 0) return {};
    return {
      invalid: hidden.map(file => ({
        name: file.name,
        path: file.path,
        reason: file.reason,
      })),
      notice: invalidSkillsNotice(hidden),
    };
  };

  return {
    save_skill: tool({
      description: [
        "Propose or update a workspace-scoped skill — a named playbook",
        "retrieved in future sessions when its `loadWhen` trigger matches.",
        "",
        "THE BAR: save only knowledge a TEAMMATE would need in a MONTH —",
        "durable, cross-cutting workspace facts (metric definitions, mart",
        "semantics, domain rules, data-source caveats). Do NOT save:",
        "session-specific bug workarounds, product behavior of Mako itself",
        "(it changes under you), or one-off task notes.",
        "",
        "ROUTE BY SCOPE before saving: knowledge about ONE app belongs in",
        "that app's AGENTS.md (`apps/<slug>/AGENTS.md`, edit it with the app",
        "file tools); dbt-project conventions belong in `dbt/.makorules.md`;",
        "the workspace's overall business context belongs in `PROMPT.md`.",
        "Only what fits none of those becomes a skill.",
        "",
        "A NEW skill you save is a PROPOSAL: it is committed to the repo but",
        "stays inactive (suppressed) until a person activates it in the",
        "Skills panel or flips `suppressed: false` in its SKILL.md. Tell the",
        "user you proposed it. Updates to an existing skill apply directly.",
        "",
        "Choose `name` as a stable lowercase identifier (`-` or `_`); write `loadWhen`",
        "as ONE trigger line (it is in every prompt); keep `body` compact",
        "and structured.",
      ].join("\n"),
      inputSchema: saveSkillSchema,
      execute: async input => {
        const result = await saveSkill(workspaceId, input, authorId, {
          origin: "agent",
        });
        if (result.success && result.skill.pendingApproval) {
          return {
            ...result,
            note:
              "Saved as a PROPOSAL — inactive until a person activates it " +
              "in the Skills panel (or sets `suppressed: false` in " +
              `skills/${result.skill.name}/SKILL.md). Let the user know.`,
          };
        }
        return result;
      },
    }),
    delete_skill: tool({
      description:
        "Delete a workspace skill by name. Use this to retract a skill that turned out to be wrong — without deletion, bad skills poison every future query. The current file is removed; git history retains prior versions.",
      inputSchema: deleteSkillSchema,
      execute: async ({ name }) => {
        return deleteSkill(workspaceId, name, authorId);
      },
    }),
    list_skills: tool({
      description: [
        "List every available skill (workspace + system) as a compact index:",
        "name, loadWhen trigger, scope, and optional references paths.",
        "Bodies are NOT included — call load_skill / read_skill_resource for",
        "a specific skill, or get_relevant_skills for keyword matches with bodies.",
        "Prefer this over guessing skill names.",
        "`loads30d` and `lastLoadedAt` say how often each skill was read.",
        "`invalid` lists workspace skill files hidden from the agent, with the",
        "reason; `warnings` lists loaded skills with a problem to fix.",
      ].join(" "),
      inputSchema: listSkillsSchema,
      execute: async () => {
        // Index only; pinned bodies are omitted from this tool response.
        const result = await retrieveRelevantSkills(workspaceId);
        // Files under skills/ that never reach the index, with why: without
        // this a bad folder name or frontmatter fails silently for agents.
        const { invalid, warnings } = await loadSkillCatalog(workspaceId);
        const usageOf = await skillUsageForIndex(workspaceId);
        return {
          success: true as const,
          skills: result.index.map(s => ({
            name: s.name,
            loadWhen: s.loadWhen,
            scope: s.scope,
            ...(s.pinned ? { pinned: true } : {}),
            ...(s.references && s.references.length > 0
              ? { references: s.references }
              : {}),
            ...(usageOf ? usageOf(s.scope, s.name) : {}),
          })),
          ...(invalid.length > 0
            ? {
                invalid: invalid.map(i => ({
                  name: i.name,
                  path: i.path,
                  reason: i.reason,
                })),
                invalidNote:
                  "These workspace skill files are NOT in the index. Tell the user and name the fix.",
              }
            : {}),
          ...(warnings.length > 0
            ? {
                warnings: warnings.map(w => ({
                  name: w.name,
                  path: w.path,
                  reason: w.reason,
                })),
              }
            : {}),
        };
      },
    }),
    get_relevant_skills: tool({
      description: [
        "Keyword-match skills (workspace and system) against a task and return the best",
        "matches with their full bodies. Call this at the start of a",
        "multi-step task when the index in your prompt did not point at an",
        "obvious skill; otherwise prefer load_skill by name.",
      ].join(" "),
      inputSchema: getRelevantSkillsSchema,
      execute: async ({ query }) => {
        const hits = await searchSkills(workspaceId, query, 3);
        recordSkillUsage(
          workspaceId,
          hits.map(h => ({ skill: h.name, scope: h.scope })),
          "relevant",
          source,
        );
        return {
          success: true as const,
          relevant: hits.map(h => ({
            name: h.name,
            loadWhen: h.loadWhen,
            scope: h.scope,
            score: Math.round(h.score * 100) / 100,
            body: h.body,
          })),
          ...(await hiddenMatches(query)),
        };
      },
    }),
    load_skill: tool({
      description:
        "Load a skill by name from the index — its full body. Do this as soon as an index entry matches what you are about to do. `resources` lists the skill's extra files (path, bytes): read one with read_skill_resource.",
      inputSchema: loadSkillSchema,
      execute: async ({ name }) => {
        const result = await loadSkill(workspaceId, name);
        if (result.success) {
          recordSkillUsage(
            workspaceId,
            [
              {
                skill: result.skill.name,
                scope: skillScopeFromId(result.skill.id),
              },
            ],
            "load",
            source,
          );
        }
        return result;
      },
    }),
    read_skill_resource: tool({
      description: [
        "Read one extra file of a skill: a reference, a SQL recipe, a script.",
        "Workspace skills serve text files under `references/`, `scripts/` and",
        "`resources/`; system skills serve `references/*.md`. Use it after the",
        "index or `load_skill` lists the path and the task needs that detail.",
        "This tool only reads: Mako never runs a script. To run one, execute",
        "the returned text in your own shell or sandbox.",
      ].join(" "),
      inputSchema: readSkillResourceSchema,
      execute: async ({ name, path }) => {
        const result = await readSkillResource(workspaceId, name, path);
        if (result.success) {
          recordSkillUsage(
            workspaceId,
            [{ skill: result.skill, scope: result.scope }],
            "resource",
            source,
          );
        }
        return result;
      },
    }),
    search_skills: tool({
      description:
        "Search skills (workspace and system) by keywords (names, descriptions, entities, bodies). Use when no index line rang a bell. Returns matches with full bodies.",
      inputSchema: searchSkillsSchema,
      execute: async ({ query, limit }) => {
        const hits = await searchSkills(workspaceId, query, limit ?? 5);
        recordSkillUsage(
          workspaceId,
          hits.map(h => ({ skill: h.name, scope: h.scope })),
          "relevant",
          source,
        );
        return {
          success: true,
          results: hits.map(h => ({
            name: h.name,
            loadWhen: h.loadWhen,
            body: h.body,
            score: Math.round(h.score * 100) / 100,
          })),
          ...(await hiddenMatches(query)),
        };
      },
    }),
  };
}
