---
title: Skills
description: Workspace-scoped playbooks the agent can author and load on demand.
---

Skills are named, workspace-scoped playbooks the agent writes for itself. Each skill has a short trigger (`loadWhen`), a body of schema facts or procedures, and a set of entities used for retrieval. When a user sends a message, Mako automatically surfaces the most relevant skills into the agent's context.

They complement the [Self-Directive](/self-directive/): the self-directive is a single always-on document, while skills are targeted playbooks that load only when their trigger matches. Use skills for things that should fire only under specific conditions -- a per-country sales query, a multi-step reconciliation procedure, a rare schema gotcha.

## How Retrieval Works

Every agent turn does the following before the LLM call:

1. **Index injection** -- the compact list of every non-suppressed skill in the workspace (name + `loadWhen`) is always injected into the system prompt. The agent can see everything that exists, even if nothing matches strongly.
2. **Scoring** -- the user's message is embedded and compared against every skill's `loadWhen` embedding. A weighted score is computed:
   - Entity overlap (0.6) -- tokens extracted from the message vs the skill's entities
   - Semantic similarity (0.4) -- cosine similarity on the `loadWhen` embedding
3. **Auto-injection** -- the top 3 skills with a composite score ≥ 0.25 have their full bodies injected into the system prompt.
4. **Explicit load** -- if the agent sees a skill in the index that wasn't auto-loaded but looks relevant, it can call `load_skill` to pull it mid-turn.

Skills survive across sessions and are shared across all members of the workspace.

## Agent Tools

| Tool            | What It Does                                                                                  |
| --------------- | --------------------------------------------------------------------------------------------- |
| `save_skill`    | Upsert a skill by name. Reusing the same name overwrites the body (one undo step is retained) |
| `delete_skill`  | Retract a skill permanently. Use when a skill turned out to be wrong                          |
| `load_skill`    | Explicitly load a skill from the index mid-turn. Bumps `useCount` for retrieval reinforcement |
| `search_skills` | Free-text search over all skills in the workspace. Fallback when the index doesn't surface it |

`save_skill` accepts:

- `name` (required) -- lowercase `snake_case`, max 80 chars, unique within the workspace
- `loadWhen` (required) -- 1-2 sentence trigger phrase, max 500 chars
- `body` (required) -- the playbook content, max 20,000 chars
- `entities` (optional) -- author-declared triggers (table names, concepts, country codes). Unioned with the automatic extractor's output

## What Good Skills Look Like

A skill should have a sharp trigger and a compact body. Bad skills have vague triggers and dump generic prose.

**Good trigger:** `Building a sales report, computing MRR, or answering "who are the best salespeople"`

**Bad trigger:** `Answering questions about revenue`

**Good body:** Mixes schema facts, gotchas, and example patterns, all tied to specific tables and columns.

**Bad body:** Paragraphs of narrative without concrete identifiers.

## Admin UI

Settings → Skills lists every skill in the workspace. For each skill you can:

- **Edit** -- rewrite the `loadWhen`, body, or entities. Takes effect on the next agent turn
- **Suppress** -- disable the skill without deleting it. Suppressed skills stay in the database but are excluded from the index and retrieval
- **Delete** -- permanently remove the skill

The hard cap is 200 skills per workspace, which keeps the injected index bounded.

## REST API

All endpoints are mounted under `/api/workspaces/:workspaceId/skills` and require authentication plus workspace access.

| Method   | Endpoint                  | Description                             |
| -------- | ------------------------- | --------------------------------------- |
| `GET`    | `/`                       | List all skills in the workspace        |
| `GET`    | `/:id`                    | Get a single skill with full body       |
| `PUT`    | `/:id`                    | Edit `loadWhen`, `body`, or `entities`  |
| `POST`   | `/:id/suppress`           | Toggle the `suppressed` flag            |
| `DELETE` | `/:id`                    | Permanently delete a skill              |

See [API Reference](/api-reference/#skills) for the full response schema.

## Relationship to the Self-Directive

Both are workspace-scoped persistent memory, but they serve different purposes:

| Aspect        | Self-Directive                                 | Skills                                                |
| ------------- | ---------------------------------------------- | ----------------------------------------------------- |
| Structure     | One text document, up to 10,000 chars          | Many named playbooks, up to 20,000 chars each         |
| Loading       | Always in context                              | Retrieved on demand based on trigger + similarity     |
| Scope         | Broad workspace-wide rules                     | Targeted, condition-specific playbooks                |
| Use when      | Something always applies                       | Something applies only in a specific situation        |

In practice: put a naming convention in the self-directive, put the full `monthly_recurring_revenue` computation procedure in a skill.
