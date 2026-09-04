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
      "Pin the skill: its full body rides in every prompt. Reserve for the two or three skills every turn needs (glossaries, warehouse maps). Omit to keep the current setting.",
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
      "Keywords describing the task; the best-matching skills come back with their full bodies.",
    ),
});

export function createSkillTools(workspaceId: string, userId?: string) {
  const authorId = userId && userId.length > 0 ? userId : "agent";

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
        "Choose `name` as a stable snake_case identifier; write `loadWhen`",
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
        "Delete a workspace skill by name. Use this to retract a skill that turned out to be wrong — without deletion, bad skills poison every future query. Deletion is permanent.",
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
      ].join(" "),
      inputSchema: listSkillsSchema,
      execute: async () => {
        // Empty query → index only (no body injection / useCount bumps).
        const result = await retrieveRelevantSkills(workspaceId);
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
          })),
        };
      },
    }),
    get_relevant_skills: tool({
      description: [
        "Keyword-match workspace skills against a task and return the best",
        "matches with their full bodies. Call this at the start of a",
        "multi-step task when the index in your prompt did not point at an",
        "obvious skill; otherwise prefer load_skill by name.",
      ].join(" "),
      inputSchema: getRelevantSkillsSchema,
      execute: async ({ query }) => {
        const hits = await searchSkills(workspaceId, query, 3);
        return {
          success: true as const,
          relevant: hits.map(h => ({
            name: h.name,
            loadWhen: h.loadWhen,
            scope: h.scope,
            score: Math.round(h.score * 100) / 100,
            body: h.body,
          })),
        };
      },
    }),
    load_skill: tool({
      description:
        "Load a skill by name from the index — its full body. Do this as soon as an index entry matches what you are about to do.",
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
        "Search workspace skills by keywords (names, descriptions, entities, bodies). Use when no index line rang a bell. Returns matches with full bodies.",
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
          })),
        };
      },
    }),
  };
}
