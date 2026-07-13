/**
 * Skill tools — agent-side CRUD + search for the skills system (issue #365).
 *
 * Tools:
 *   - save_skill / delete_skill     workspace skill writes (in-product)
 *   - list_skills                   compact index (workspace + system)
 *   - get_relevant_skills           same retrieval as pre-turn auto-inject
 *   - load_skill                    explicit load by name
 *   - read_skill_resource           system skill references/*.md
 *   - search_skills                 free-text fallback
 *
 * The in-product agent also gets the index + top-k bodies injected into the
 * system prompt before each turn. MCP clients do not — they call list_skills /
 * get_relevant_skills instead.
 */

import { tool } from "ai";
import { z } from "zod";
import {
  deleteSkill,
  loadSkill,
  readSkillResource,
  retrieveRelevantSkills,
  saveSkill,
  searchSkills,
} from "../../services/skills.service";

const saveSkillSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(80)
    .regex(/^[a-z0-9_]+$/, "name must be lowercase snake_case")
    .describe(
      "Unique skill name. Lowercase snake_case. Stable identifier — reuse the same name to overwrite an existing skill (the previous body is preserved for one undo step).",
    ),
  loadWhen: z
    .string()
    .min(1)
    .max(500)
    .describe(
      "Short (1-2 sentence) description of when to load this skill. This is the primary retrieval signal; write it as a trigger, e.g. 'building a sales report or answering \"who are the best salespeople\"'.",
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
      "Optional author-declared triggers (table names, columns, business concepts, country names, etc.) — unioned with extractor output to improve retrieval. Include synonyms (e.g. 'revenue' if the body talks about 'MRR').",
    ),
});

const deleteSkillSchema = z.object({
  name: z
    .string()
    .min(1)
    .describe("Skill name to delete. Deletion is permanent."),
});

const loadSkillSchema = z.object({
  name: z
    .string()
    .min(1)
    .describe(
      "Skill name to explicitly load. Use this when you see a skill in the index whose loadWhen matches what you're about to do but it wasn't auto-loaded.",
    ),
});

const searchSkillsSchema = z.object({
  query: z
    .string()
    .min(1)
    .describe(
      "Free-text query. Use this as a fallback when the injected skills index doesn't show an obvious match.",
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
      "Name of the `[system]` skill that owns the resource, e.g. `dashboards`.",
    ),
  path: z
    .string()
    .min(1)
    .describe(
      "Relative markdown path under the skill's references/ directory. The skill index lists available references.",
    ),
});

const listSkillsSchema = z.object({});

const getRelevantSkillsSchema = z.object({
  query: z
    .string()
    .min(1)
    .describe(
      "Natural-language task or question to rank skills against — same signal the in-product agent uses for pre-turn auto-injection.",
    ),
});

export function createSkillTools(workspaceId: string, userId?: string) {
  const authorId = userId && userId.length > 0 ? userId : "agent";

  return {
    save_skill: tool({
      description: [
        "Save or overwrite a workspace-scoped skill — a named playbook that",
        "will be auto-injected into future sessions when its `loadWhen`",
        "trigger matches the user query. Use this whenever the user teaches",
        "you something durable about this workspace (a schema fact, a gotcha,",
        "a query pattern, a definition). Skills survive across sessions.",
        "",
        "Choose `name` as a stable snake_case identifier (e.g.",
        "`mrr_walkthrough_fr`, `sms_funnel_conversion`). Write `loadWhen` as",
        "a trigger phrase — what query or task should cause this to load.",
        "Keep `body` compact and structured.",
      ].join("\n"),
      inputSchema: saveSkillSchema,
      execute: async input => {
        return saveSkill(workspaceId, input, authorId);
      },
    }),
    delete_skill: tool({
      description:
        "Delete a workspace skill by name. Use this to retract a skill that turned out to be wrong — without deletion, bad skills poison every future query. Deletion is permanent.",
      inputSchema: deleteSkillSchema,
      execute: async ({ name }) => {
        return deleteSkill(workspaceId, name);
      },
    }),
    list_skills: tool({
      description: [
        "List every available skill (workspace + system) as a compact index:",
        "name, loadWhen trigger, scope, and optional references paths.",
        "Bodies are NOT included — call get_relevant_skills for ranked bodies,",
        "or load_skill / read_skill_resource for a specific skill.",
        "Prefer this over guessing skill names.",
      ].join(" "),
      inputSchema: listSkillsSchema,
      execute: async () => {
        // Empty query → index only (no body injection / useCount bumps).
        const result = await retrieveRelevantSkills(workspaceId, "");
        return {
          success: true as const,
          skills: result.index.map(s => ({
            name: s.name,
            loadWhen: s.loadWhen,
            scope: s.scope,
            ...(s.references && s.references.length > 0
              ? { references: s.references }
              : {}),
          })),
        };
      },
    }),
    get_relevant_skills: tool({
      description: [
        "Rank skills against a task/query and return the top relevant bodies",
        "(same retrieval the in-product agent auto-injects each turn).",
        "Call this at the start of a multi-step task, or when switching domains",
        "(e.g. apps → SQL dialect). Also returns near-misses so you can",
        "load_skill anything the threshold skipped.",
      ].join(" "),
      inputSchema: getRelevantSkillsSchema,
      execute: async ({ query }) => {
        const result = await retrieveRelevantSkills(workspaceId, query);
        return {
          success: true as const,
          queryEntities: result.queryEntities,
          relevant: result.injected.map(h => ({
            name: h.name,
            loadWhen: h.loadWhen,
            scope: h.scope,
            score: Math.round(h.score * 100) / 100,
            body: h.body,
          })),
          considered: result.considered.map(h => ({
            name: h.name,
            loadWhen: h.loadWhen,
            scope: h.scope,
            score: Math.round(h.score * 100) / 100,
          })),
        };
      },
    }),
    load_skill: tool({
      description:
        "Explicitly load a skill by name from the index. Use this when you spot a skill in the index whose `loadWhen` matches what you're about to do, but it wasn't auto-loaded. Bumps the skill's useCount so retrieval can reinforce it later.",
      inputSchema: loadSkillSchema,
      execute: async ({ name }) => {
        return loadSkill(workspaceId, name);
      },
    }),
    read_skill_resource: tool({
      description:
        "Read a tier-3 markdown reference file for a system skill. Use this only after the skill index or a loaded system skill points to a specific `references/*.md` path and the task needs that deeper detail.",
      inputSchema: readSkillResourceSchema,
      execute: async ({ name, path }) => {
        return readSkillResource(name, path);
      },
    }),
    search_skills: tool({
      description:
        "Search workspace skills by free-text query. Fallback for when the injected skills index doesn't surface something you know should exist. Returns ranked full bodies.",
      inputSchema: searchSkillsSchema,
      execute: async ({ query, limit }) => {
        const hits = await searchSkills(workspaceId, query, limit ?? 5);
        return {
          success: true,
          results: hits.map(h => ({
            name: h.name,
            loadWhen: h.loadWhen,
            body: h.body,
            score: Math.round(h.score * 100) / 100,
            entityOverlap: h.entityOverlap,
          })),
        };
      },
    }),
  };
}
