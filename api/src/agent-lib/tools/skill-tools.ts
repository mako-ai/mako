/**
 * Skill tools — agent-side CRUD + search for the skills system (issue #365).
 *
 * Four tools:
 *   - save_skill     upsert a named playbook (auto-extracts entities)
 *   - delete_skill   retract a skill by name
 *   - load_skill     explicit load; appears in trace, forces commitment
 *   - search_skills  fallback when the injected index misses
 *
 * The main retrieval happens *before* the agent runs — the system prompt
 * is pre-populated with the skill index and top-k auto-loaded bodies. These
 * tools exist so the agent can (a) write what it learns, (b) correct itself
 * by deleting wrong skills, (c) pull a specific skill mid-turn, and (d) run
 * a direct search if the index hint didn't fire.
 */

import { z } from "zod";
import {
  deleteSkill,
  loadSkill,
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

type SaveInput = z.infer<typeof saveSkillSchema>;
type DeleteInput = z.infer<typeof deleteSkillSchema>;
type LoadInput = z.infer<typeof loadSkillSchema>;
type SearchInput = z.infer<typeof searchSkillsSchema>;

export function createSkillTools(workspaceId: string, userId?: string) {
  const authorId = userId && userId.length > 0 ? userId : "agent";

  return {
    save_skill: {
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
      execute: async (input: SaveInput) => {
        return saveSkill(workspaceId, input, authorId);
      },
    },
    delete_skill: {
      description:
        "Delete a workspace skill by name. Use this to retract a skill that turned out to be wrong — without deletion, bad skills poison every future query. Deletion is permanent.",
      inputSchema: deleteSkillSchema,
      execute: async ({ name }: DeleteInput) => {
        return deleteSkill(workspaceId, name);
      },
    },
    load_skill: {
      description:
        "Explicitly load a skill by name from the index. Use this when you spot a skill in the injected index whose `loadWhen` matches what you're about to do, but it wasn't auto-loaded. Bumps the skill's useCount so retrieval can reinforce it later.",
      inputSchema: loadSkillSchema,
      execute: async ({ name }: LoadInput) => {
        return loadSkill(workspaceId, name);
      },
    },
    search_skills: {
      description:
        "Search workspace skills by free-text query. Fallback for when the injected skills index doesn't surface something you know should exist. Returns ranked full bodies.",
      inputSchema: searchSkillsSchema,
      execute: async ({ query, limit }: SearchInput) => {
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
    },
  };
}
