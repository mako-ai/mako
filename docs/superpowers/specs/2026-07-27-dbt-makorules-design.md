# `.makorules` — user-authored dbt rules

**Date:** 2026-07-27
**Branch:** `feat/dbt-makorules`

## Problem

Mako's dbt agent writes SQL from its built-in conventions (staging models as
views under `models/staging/`, marts as tables, etc.) plus the `dbt` system
skill. Teams have their own conventions — naming, CTE style, required tests,
banned patterns — and today the only way to express them is the workspace-wide
`settings.customPrompt`, which is not versioned, not per-project, and not
visible next to the code it governs.

`.cursorrules` and `.naorules` solve this by putting the rules in the repo. This
spec does the same for Mako's dbt projects.

## Goals

- A markdown rules file at the dbt project root that the dbt agent obeys on
  every turn, without the user having to mention it.
- Versioned with the project: syncs from GitHub, commits and pushes through the
  existing dbt git tools, shared with the whole team.
- Editable in the Transforms explorer like any other project file.

## Non-goals

- Non-dbt SQL contexts (console/SQL editor agent). The rules file is dbt-scoped.
- Nested per-directory rules files.
- Glob-scoped rules à la `.cursor/rules/*.mdc`.
- Any new agent tool (avoids tool-catalog tier classification entirely).
- Auto-scaffolding a template file into new projects.

## Design

### 1. File location and resolution

A markdown file at the dbt project root, resolved first-hit-wins:

1. `.makorules.md`
2. `.makorules`

It is an ordinary working-tree file — a `DbtFile` base row plus the per-user
`DbtFileDraft` overlay, exactly like a model or a `schema.yml`. Consequences,
all of them free:

- Visible and editable in the Transforms explorer (`DbtExplorer.tsx` filters
  only `.gitkeep`, so a dotfile shows up already).
- Committed and pushed by `dbt_commit_and_push` / `dbt_commit_to_branch`; the
  git service pushes the working tree without an extension filter.
- Branch-scoped: a `.makorules.md` change on a feature branch governs work on
  that branch only, and switching branches carries each branch's version.
- A user's **uncommitted draft applies to their own agent turns immediately**,
  because drafts are per-user by design. Editing the rules and re-prompting is a
  single loop with no commit in between.

#### Required fix: dotfile import

`hasTextExtension()` in `api/src/dbt/dbt-github-sync.service.ts:77` computes the
extension with `dot > 0`, so for a leading-dot filename like `.makorules` the
extension resolves to the empty string and `isImportable()` returns `false` —
the file is silently dropped when a repo is imported or re-synced.

Fix: whitelist the exact basename `.makorules` alongside the existing
`.gitkeep` exception in `hasTextExtension()`. `.makorules.md` already passes the
filter unchanged.

### 2. Loading — `api/src/dbt/dbt-rules.service.ts` (new)

```ts
export const DBT_RULES_PATHS = [".makorules.md", ".makorules"] as const;
export const DBT_RULES_MAX_CHARS = 16_000;

export interface DbtRules {
  path: string;
  contents: string;
  truncated: boolean;
}

export async function resolveDbtRules(
  project: IDbtProject,
  userId: string | undefined,
): Promise<DbtRules | null>;
```

Reads each candidate path via `readWorkingFile` (draft-over-base) in order and
returns the first that exists with non-whitespace contents. Contents over
`DBT_RULES_MAX_CHARS` (~4k tokens) are cut at that boundary and marked
`truncated: true`; the renderer appends an explicit
`[.makorules truncated at 16000 characters]` line rather than cutting silently.

Returns `null` when neither file exists. Pure over the working tree — no prompt
or HTTP concerns, independently testable.

A sibling renderer keeps prompt wording in one place:

```ts
export function renderDbtRulesBlock(
  rules: DbtRules,
  projectName: string,
): string;
```

### 3. Resolving which project

`resolveDbtRules` needs a project. The caller resolves one in this order:

1. **`context.dbtProjectId`** — the active dbt tab's project, else the first
   open dbt tab's project.
2. **Sole project** — if the workspace has exactly one `DbtProject`, use it.
3. **Otherwise** — no injection.

Step 1 needs a small frontend change. `buildOpenTabs()`
(`app/src/agent-runtime/request-context.ts:67`) already forwards
`tab.metadata` fields for dashboard, flow, and notebook tabs, but drops
`metadata.projectId` for `dbt-*` tabs. Add a `dbtProjectId` field for tab kinds
`dbt-file`, `dbt-job`, and `dbt-console`, and widen the `openTabs` element type
in `api/src/agents/types.ts` to match.

**Belt-and-braces for case 3.** `read_dbt_project_tree`, when called with a
`projectId`, additionally returns the resolved rules inline:

```jsonc
{
  "success": true,
  "projectId": "…",
  "files": ["…"],
  "rules": { "path": ".makorules.md", "contents": "…" } // or omitted
}
```

Multi-project workspaces therefore still receive the rules the moment the agent
orients — which the dbt workflow makes it do first, by contract. This is the
only gap-closer needed and costs no new tool.

### 4. Injection into the prompt

`agent.routes.ts` pre-renders a `dbtRulesBlock: string` into the agent context,
alongside the existing `skillsBlock` and `workspaceCustomPrompt`. Resolution
failures are caught and logged at `warn`, never fatal to the turn — same
treatment as the workspace custom prompt load.

Both consumers render it in their **dynamic** system message, never in the
1h-cached base prompt:

- `api/src/agents/dbt/index.ts` — appended to the second system message,
  before `buildRuntimeContext(context)`.
- `api/src/agents/unified/prompt.ts` — a section next to `Workspace Context`,
  emitted only when non-empty. This covers the dbt expertise mode, which is
  what production chat actually resolves to.

The rendered block states precedence explicitly, highest first:

> explicit user instructions in this conversation → `.makorules` → workspace
> instructions → the `dbt` system skill → Mako's built-in defaults

and is framed as binding rather than advisory. It names the file path so the
agent can cite it when declining something the rules forbid.

### 5. Discovery

- One line in `DBT_AGENT_PROMPT` (`api/src/agents/dbt/prompt.ts`) and in
  `TRANSFORM_MODE_SYSTEM_PROMPT` (`api/src/agents/modes/prompts.ts`): when the
  user states a durable convention ("always…", "never…", "we use…"), offer to
  record it in `.makorules.md`. Creating it uses the existing `create_dbt_file`
  tool.
- A "Project rules" section appended to the existing
  `docs/src/content/docs/transforms.md`, covering the filename, precedence, and
  an example file.
- A pointer in the `dbt` system skill (`api/src/agent-skills/dbt/SKILL.md`).

No new UI and no new tool.

## Testing

| Test                                              | Covers                                                                                   |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `api/src/dbt/dbt-rules.service.test.ts` (new)      | `.makorules.md` wins over `.makorules`; whitespace-only treated as absent; missing → `null`; over-cap truncation sets the flag; a user draft shadows the committed base |
| `api/src/dbt/dbt-github-sync.test.ts` (extend)     | `isImportable(".makorules")` and `isImportable(".makorules.md")` are both `true`          |
| `api/src/agent-lib/tools/dbt-file-tools.test.ts` (extend) | `read_dbt_project_tree` returns `rules` when the file exists and omits the key when it does not |
| `app/src/agent-runtime/request-context.test.ts` (extend) | `buildOpenTabs` forwards `dbtProjectId` for dbt tab kinds and leaves it undefined elsewhere |
| Prompt rendering                                  | The block appears in both the dbt agent and unified prompts when rules exist, and is absent when they do not |
| `api/src/agents/prompt-size.test.ts` (existing)    | No base-prompt size regression                                                            |

## Files touched

**API**

- `api/src/dbt/dbt-rules.service.ts` — new (resolve + render)
- `api/src/dbt/dbt-rules.service.test.ts` — new
- `api/src/dbt/dbt-rules-turn.service.ts` — new (`resolveDbtRulesBlockForTurn`:
  turn-level project resolution, so `agent.routes.ts` stays thin)
- `api/src/dbt/dbt-rules-turn.service.test.ts` — new
- `api/src/dbt/dbt-rules-prompt-wiring.test.ts` — new (both prompt consumers)
- `api/src/dbt/dbt-github-sync.service.ts` — dotfile whitelist
- `api/src/agent-lib/tools/dbt-tools.ts` — `rules` on `read_dbt_project_tree`
- `api/src/agents/types.ts` — `dbtRulesBlock`, `openTabs[].dbtProjectId`
- `api/src/agent-lib/types.ts` — `dbtRulesBlock`
- `api/src/routes/agent.routes.ts` — resolve + pre-render the block
- `api/src/agents/dbt/index.ts`, `api/src/agents/dbt/prompt.ts`
- `api/src/agents/unified/prompt.ts`, `api/src/agents/modes/prompts.ts`
- `api/src/agent-skills/dbt/SKILL.md`

**App**

- `app/src/agent-runtime/request-context.ts` — forward `dbtProjectId`

**Docs**

- `docs/src/content/docs/transforms.md` — new "Project rules" section

## Example `.makorules.md`

```markdown
# SQL conventions for this project

- Every model starts with import CTEs (`with source as (select * from {{ ref(...) }})`),
  one per upstream, then transform CTEs, then a single `select` at the bottom.
- Never `select *` outside an import CTE.
- Columns are `snake_case`; booleans are prefixed `is_` or `has_`.
- Money is stored in minor units and suffixed `_cents`.
- Every mart model needs a `unique` + `not_null` test on its primary key in
  `schema.yml`, in the same PR.
- Never hardcode a schema or table name — always `{{ ref() }}` or `{{ source() }}`.
```
