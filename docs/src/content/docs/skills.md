---
title: Skills
description: Workspace-scoped playbooks the agent can author and load on demand.
---

Skills are named, workspace-scoped playbooks stored in the workspace repository as `skills/<name>/SKILL.md`. Each skill has a short trigger (`description` in the file, exposed as `loadWhen` by the API), a body of schema facts or procedures, and optional search keywords. The files on the repository's main branch are the source of truth.

They complement the [Self-Directive](/self-directive/): the self-directive is a single always-on document, while skills are targeted playbooks that load only when their trigger matches. Use skills for things that should fire only under specific conditions -- a per-country sales query, a multi-step reconciliation procedure, a rare schema gotcha.

## How Loading Works

Every agent turn does the following before the LLM call:

1. **Index injection** -- the compact list of every non-suppressed workspace and system skill (name + description) is injected into the system prompt. The agent can see everything that exists.
2. **Pinned excerpts** -- pinned workspace skills include their bodies automatically, within the shared prompt budget. Pin only the small number of skills needed on nearly every turn.
3. **Explicit load** -- when an index entry matches the task, the agent calls `load_skill` for the complete body.
4. **Keyword fallback** -- `search_skills` and `get_relevant_skills` match terms against workspace skill names, descriptions, entities, and bodies when the index entry was not enough.

Skills survive across sessions and are shared across all members of the workspace.

## Agent Tools

| Tool                  | What It Does                                                                                                 |
| --------------------- | ------------------------------------------------------------------------------------------------------------ |
| `save_skill`          | Commit a new or updated workspace skill by name. New agent-authored skills start suppressed pending approval |
| `delete_skill`        | Remove the current skill file; earlier versions remain in git history                                        |
| `load_skill`          | Load a workspace or system skill's complete body by name                                                     |
| `list_skills`         | List the workspace and system skill index                                                                    |
| `get_relevant_skills` | Return the best workspace keyword matches with their bodies                                                  |
| `search_skills`       | Search workspace skill names, descriptions, entities, and bodies                                             |

`save_skill` accepts:

- `name` (required) -- lowercase `snake_case`, max 80 chars, unique within the workspace
- `loadWhen` (required) -- one trigger line, max 300 chars
- `body` (required) -- the playbook content, max 20,000 chars
- `entities` (optional) -- author-declared search keywords such as table names, concepts, or country codes
- `pinned` (optional) -- include a budgeted body excerpt in every prompt; reserve this for a few always-needed skills

New skills proposed by the agent are committed with `suppressed: true`. Activate them from Settings → Skills or by editing the file in git.

## What Good Skills Look Like

A skill should have a sharp trigger and a compact body. Bad skills have vague triggers and dump generic prose.

**Good trigger:** `Building a sales report, computing MRR, or answering "who are the best salespeople"`

**Bad trigger:** `Answering questions about revenue`

**Good body:** Mixes schema facts, gotchas, and example patterns, all tied to specific tables and columns.

**Bad body:** Paragraphs of narrative without concrete identifiers.

## Admin UI

Settings → Skills lists every skill in the workspace. For each skill you can:

- **Edit** -- rewrite the `loadWhen`, body, or entities. Takes effect on the next agent turn
- **Pin** -- include a budgeted body excerpt in every prompt
- **Suppress** -- keep the file but exclude the skill from the prompt index and keyword search
- **Delete** -- remove the current file; git history remains available for recovery

API-created skills are capped at 200 per workspace. Files that do not parse or exceed the body/file limits are shown as invalid and are never offered to the agent.

## REST API

All endpoints are mounted under `/api/workspaces/:workspaceId/skills` and require authentication plus workspace access.

| Method   | Endpoint        | Description                                      |
| -------- | --------------- | ------------------------------------------------ |
| `GET`    | `/`             | List all skills in the workspace                 |
| `GET`    | `/:id`          | Get a single skill with full body                |
| `PUT`    | `/:id`          | Edit `loadWhen`, `body`, `entities`, or `pinned` |
| `POST`   | `/:id/suppress` | Toggle the `suppressed` flag                     |
| `POST`   | `/:id/pin`      | Toggle the `pinned` flag                         |
| `DELETE` | `/:id`          | Remove the current skill file                    |

See [API Reference](/api-reference/#skills) for the full response schema.

## Relationship to the Self-Directive

Both are workspace-scoped persistent memory, but they serve different purposes:

| Aspect    | Self-Directive                        | Skills                                                 |
| --------- | ------------------------------------- | ------------------------------------------------------ |
| Structure | One text document, up to 10,000 chars | Many named playbooks, up to 20,000 chars each          |
| Loading   | Always in context                     | Index always present; body loaded explicitly or pinned |
| Scope     | Broad workspace-wide rules            | Targeted, condition-specific playbooks                 |
| Use when  | Something always applies              | Something applies only in a specific situation         |

In practice: put a naming convention in the self-directive, put the full `monthly_recurring_revenue` computation procedure in a skill.
