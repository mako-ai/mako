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
| `load_skill`          | Load a workspace or system skill's complete body by name, with the list of its resource files                |
| `read_skill_resource` | Read one resource file of a skill. Reading only: Mako never runs a script                                    |
| `list_skills`         | List the workspace and system skill index, with usage, hidden files and warnings                             |
| `get_relevant_skills` | Return the best workspace keyword matches with their bodies                                                  |
| `search_skills`       | Search workspace skill names, descriptions, entities, and bodies                                             |

`save_skill` accepts:

- `name` (required) -- the folder name: lowercase letters, digits, `-` and `_`, starting with a letter or digit (`revenue-walkthrough`, `mrr_fr`), max 80 chars, unique within the workspace. `foo-bar` and `foo_bar` count as the same name: a save refuses the second spelling, and `load_skill` finds a skill by either one
- `loadWhen` (required) -- one trigger line, max 300 chars
- `body` (required) -- the playbook content, max 20,000 chars
- `entities` (optional) -- author-declared search keywords such as table names, concepts, or country codes
- `pinned` (optional) -- include a budgeted body excerpt in every prompt; reserve this for a few always-needed skills

New skills proposed by the agent are committed with `suppressed: true`. Activate them from Settings → Skills or by editing the file in git.

## Limits

| Limit                    | Value                   | Over the limit                                  |
| ------------------------ | ----------------------- | ----------------------------------------------- |
| Body                     | 20,000 characters       | The skill is hidden                             |
| `SKILL.md` file          | 64,000 bytes            | The skill is hidden                             |
| Skills per workspace     | 200                     | The skills past 200 (by name) are hidden        |
| Description in the index | 200 characters          | The index cuts it. The skill loads. A warning   |
| One resource file        | 64,000 bytes            | The file is refused. The skill loads. A warning |
| Resource files per skill | 40 files, 512,000 bytes | The files past the cap are refused. A warning   |

`save_skill` and the REST API cap a description at 300 characters. A file committed from a clone can hold a longer one.

## Hidden Skills

A skill file that breaks a limit or does not parse is hidden: it stays out of the index, and `load_skill` does not find it. Mako reports each hidden file with its path and the reason in four places:

1. **The commit.** Every push to main gets a `mako/skills` commit status on GitHub. One hidden file fails the commit and the status names it: `1 skill file hidden from the agent: skills/glossary/SKILL.md: body 24,713 chars over the 20,000 limit`. A warning passes the commit and shows in the status text. A workspace with no skill files gets no status.
2. **`list_skills`.** Hidden files come back under `invalid`, warnings under `warnings`.
3. **`get_relevant_skills` and `search_skills`.** A query that names a hidden skill returns a `notice` with the file and the reason.
4. **Settings → Skills.** A hidden file shows "invalid file" with the reason. A warning shows under the skill.

The reasons:

| Reason                                                      | Fix                                                       |
| ----------------------------------------------------------- | --------------------------------------------------------- |
| `body 24,713 chars over the 20,000 limit`                   | Move detail into `references/` files                      |
| `file 70,112 bytes over the 64,000 limit`                   | Same                                                      |
| `front matter line 7: bad indentation of a mapping entry`   | Fix the YAML on that line. Quote a value that holds a `:` |
| `front matter has no description`                           | Add `description: <when to load it>`                      |
| `no front matter: the file must start with a --- block ...` | Add the `---` block at the top of the file                |
| `the body under the front matter is empty`                  | Write the playbook under the block                        |
| `folder name must be lowercase a-z, 0-9, '-' and '_' ...`   | Rename the folder                                         |
| `over the 200 skills per workspace limit`                   | Delete or merge skills                                    |

## Resources

A skill folder can hold files next to `SKILL.md`. The agent reads them on demand, so a long skill can keep a short body.

```text
skills/revenue-recon/
  SKILL.md
  references/ledger-map.md
  scripts/backfill.sql
  resources/rates/2026.csv
```

- **Folders:** `references/`, `scripts/` and `resources/`, with any depth of subfolders. Other files in the skill folder are ignored.
- **File types:** `.md` `.txt` `.sql` `.py` `.js` `.mjs` `.ts` `.sh` `.json` `.yml` `.yaml` `.csv`. Any other extension, a binary file and a symbolic link are refused with the reason.
- **Sizes:** 64,000 bytes per file, 40 files and 512,000 bytes per skill.
- **Discovery:** `load_skill` returns `resources`, a list of `{ path, size }`.
- **Reading:** `read_skill_resource({ name, path })` returns the file's text. It serves the in-product agent and MCP clients, with the same workspace access as `load_skill`.
- **No execution:** Mako never runs a resource. A caller that wants to run a script runs the returned text in its own shell or sandbox.

A path is served only when it is in the skill's own resource list. `..`, an absolute path or a backslash is refused.

Resources are committed with git: from a clone, a terminal or the repository file tools. `save_skill` writes `SKILL.md` only.

## Usage

Mako counts three events per skill: a `load_skill` that returns it, a `read_skill_resource` that returns one of its files, and a body returned by `get_relevant_skills` or `search_skills`. The index and the pinned excerpts in every prompt do not count.

`list_skills` and Settings → Skills show two numbers per skill:

- `loads30d` -- the three events over the last 30 days, the in-product agent and MCP clients together
- `lastLoadedAt` -- the time of the last event, or `null`

The counts are daily totals per workspace, skill and source (`agent` or `mcp`). Mako stores no user, chat or query with them, and drops a row 400 days after its last event. A renamed skill starts at 0.

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

API-created skills are capped at 200 per workspace. Files that do not parse or exceed the body/file limits are shown as invalid and are never offered to the agent. See [Hidden Skills](#hidden-skills).

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
