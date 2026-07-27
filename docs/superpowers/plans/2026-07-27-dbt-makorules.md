# `.makorules` dbt Project Rules Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Mako's dbt agent obey a user-authored `.makorules.md` file at the dbt project root on every turn, the way Cursor obeys `.cursorrules`.

**Architecture:** The rules file is an ordinary dbt working-tree file (`DbtFile` base row + per-user `DbtFileDraft` overlay), so it syncs from GitHub, commits through the existing git tools, and is editable in the Transforms explorer for free. A new `api/src/dbt/dbt-rules.service.ts` resolves and renders it; `agent.routes.ts` pre-renders the block into the agent context alongside the existing `skillsBlock`; the dbt agent and the unified prompt each emit it in their **dynamic** (non-cached) system message.

**Tech Stack:** TypeScript, Hono, Mongoose, Vitest (`api/vitest.config.ts` scopes the dbt suite), React/Vite frontend, Vercel AI SDK v6 tool definitions.

**Spec:** `docs/superpowers/specs/2026-07-27-dbt-makorules-design.md`

## Global Constraints

- No `any` types without justification (project rule).
- No `console.log` in API code — use the structured `logger` already imported in each module.
- **Do not add a new agent tool.** Every built-in tool must be classified core/mode/deferred or `api/src/agents/modes/tool-working-set.test.ts` fails. This feature deliberately adds zero tools.
- The base prompt constants (`DBT_AGENT_PROMPT`, `UNIFIED_SYSTEM_PROMPT`) carry a 1h Anthropic cache breakpoint. Rules content is per-project and per-turn, so it MUST go in the dynamic system message, never in those constants.
- API dbt tests run with `pnpm --filter api run test:dbt` (vitest). `api/vitest.config.ts` includes `src/dbt/**/*.test.ts` and `src/agent-lib/tools/dbt-*.test.ts`; new test files must land under those globs or the config must be extended.
- App tests run with `pnpm --filter app run test:unit`.
- Recognized filenames, in resolution order: `.makorules.md`, then `.makorules`.
- Truncation limit: `DBT_RULES_MAX_CHARS = 16_000`.
- Commit after each task with the message given in that task's final step.

---

### Task 1: Import `.makorules` from GitHub

The repo-sync extension filter computes a file's extension with `dot > 0`, so a leading-dot filename like `.makorules` resolves to an empty extension and is silently dropped on import. `.makorules.md` already passes. Without this fix a committed `.makorules` never reaches Mongo and the whole feature is invisible for that filename.

**Files:**
- Modify: `api/src/dbt/dbt-github-sync.service.ts:74-80` (`hasTextExtension`)
- Test: `api/src/dbt/dbt-github-sync.test.ts` (extend the existing `isImportable` describe block)

**Interfaces:**
- Consumes: nothing.
- Produces: `isImportable(".makorules") === true`. No signature changes.

- [ ] **Step 1: Write the failing test**

Add this `it` block inside the existing `describe("isImportable", ...)` in `api/src/dbt/dbt-github-sync.test.ts`, after the `.gitkeep` test:

```ts
  it("imports the .makorules rules file under both recognized names", () => {
    expect(isImportable(".makorules")).toBe(true);
    expect(isImportable(".makorules.md")).toBe(true);
  });

  it("still skips other extension-less dotfiles", () => {
    expect(isImportable(".env")).toBe(false);
    expect(isImportable(".dockerignore")).toBe(false);
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter api run test:dbt -- src/dbt/dbt-github-sync.test.ts`
Expected: FAIL — `expected false to be true` on `isImportable(".makorules")`. The `.makorules.md` and "still skips" assertions already pass.

- [ ] **Step 3: Write the minimal implementation**

In `api/src/dbt/dbt-github-sync.service.ts`, replace the `hasTextExtension` function (currently lines 74-80) with:

```ts
/**
 * Extension-less filenames we still import. `.gitkeep` keeps empty scaffold
 * dirs alive; `.makorules` is the project rules file the dbt agent reads
 * (see dbt-rules.service.ts). Both would otherwise be dropped, because a
 * leading-dot basename has no extension by the `lastIndexOf` rule below.
 */
const IMPORTABLE_DOTFILES = new Set([".gitkeep", ".makorules"]);

function hasTextExtension(path: string): boolean {
  const base = path.split("/").pop() ?? "";
  if (IMPORTABLE_DOTFILES.has(base)) return true;
  const dot = base.lastIndexOf(".");
  const ext = dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
  return TEXT_EXTENSIONS.has(ext);
}
```

Also update the doc comment above `TEXT_EXTENSIONS` (currently lines 43-47) to mention the rules file:

```ts
/**
 * Text extensions we import. dbt projects are SQL/YAML/CSV/Markdown; we also
 * keep .gitkeep so empty model dirs survive, and .makorules (the agent rules
 * file). Generated/vendored output and binary assets are skipped.
 */
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter api run test:dbt -- src/dbt/dbt-github-sync.test.ts`
Expected: PASS, all describe blocks green.

- [ ] **Step 5: Commit**

```bash
git add api/src/dbt/dbt-github-sync.service.ts api/src/dbt/dbt-github-sync.test.ts
git commit -m "fix(dbt): import .makorules from the repo

The sync extension filter resolved a leading-dot basename to an empty
extension, so a committed .makorules was silently dropped."
```

---

### Task 2: `dbt-rules.service.ts` — resolve and render

The core of the feature: read the rules file out of the user's working tree (draft over committed base) and render the prompt block. Pure over the working tree — no HTTP or agent concerns.

**Files:**
- Create: `api/src/dbt/dbt-rules.service.ts`
- Create: `api/src/dbt/dbt-rules.service.test.ts`

**Interfaces:**
- Consumes: `readWorkingFile(project: IDbtProject, userId: string, path: string): Promise<WorkingFile | null>` from `./dbt-working-tree.service` — returns `{ path, content, updatedAt?, updatedBy? }` or `null`, with a per-user draft shadowing the committed base.
- Produces, for Tasks 3, 4 and 6:
  - `DBT_RULES_PATHS: readonly [".makorules.md", ".makorules"]`
  - `DBT_RULES_MAX_CHARS: 16_000`
  - `interface DbtRules { path: string; contents: string; truncated: boolean }`
  - `resolveDbtRules(project: IDbtProject, userId: string | undefined): Promise<DbtRules | null>`
  - `renderDbtRulesBlock(rules: DbtRules, projectName: string): string`

- [ ] **Step 1: Write the failing test**

Create `api/src/dbt/dbt-rules.service.test.ts`. It boots an ephemeral Mongo so the real working-tree service runs (that is the behaviour under test — draft-over-base is the reason a user can edit rules and re-prompt without committing). This mirrors `api/src/agent-lib/tools/dbt-file-tools.test.ts`.

```ts
/**
 * .makorules resolution + rendering.
 *
 * Runs the REAL working-tree service against an ephemeral mongodb-memory-server
 * so draft-over-base precedence is exercised for real: a user's uncommitted
 * .makorules draft must govern their own agent turns before it is committed.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import mongoose, { Types } from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

import {
  DBT_RULES_MAX_CHARS,
  DBT_RULES_PATHS,
  renderDbtRulesBlock,
  resolveDbtRules,
} from "./dbt-rules.service";
import {
  DbtFile,
  DbtFileDraft,
  DbtProject,
  type IDbtProject,
} from "../database/workspace-schema";

let mongo: MongoMemoryServer;
const WS = new Types.ObjectId();
const CONN = new Types.ObjectId();
const USER = "u1";

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

beforeEach(async () => {
  await Promise.all([
    DbtFile.deleteMany({}),
    DbtFileDraft.deleteMany({}),
    DbtProject.deleteMany({}),
  ]);
});

async function seedProject(): Promise<IDbtProject> {
  const project = await DbtProject.create({
    workspaceId: WS,
    name: "Analytics",
    environments: [
      { name: "dev", connectionId: CONN, targetSchema: "analytics", threads: 4 },
    ],
    defaultEnvironment: "dev",
    createdBy: "tester",
    repo: {
      provider: "github",
      owner: "acme",
      repo: "analytics",
      branch: "main",
      installationId: 123,
    },
  });
  return project as unknown as IDbtProject;
}

async function seedBase(project: IDbtProject, path: string, content: string) {
  await DbtFile.create({
    workspaceId: project.workspaceId,
    projectId: project._id,
    branch: "main",
    path,
    content,
    updatedBy: "sync",
  });
}

describe("resolveDbtRules", () => {
  it("returns null when the project has no rules file", async () => {
    const project = await seedProject();
    await seedBase(project, "models/a.sql", "select 1");
    expect(await resolveDbtRules(project, USER)).toBeNull();
  });

  it("reads .makorules.md", async () => {
    const project = await seedProject();
    await seedBase(project, ".makorules.md", "- never select *");
    expect(await resolveDbtRules(project, USER)).toEqual({
      path: ".makorules.md",
      contents: "- never select *",
      truncated: false,
    });
  });

  it("falls back to .makorules when .makorules.md is absent", async () => {
    const project = await seedProject();
    await seedBase(project, ".makorules", "- snake_case only");
    expect(await resolveDbtRules(project, USER)).toEqual({
      path: ".makorules",
      contents: "- snake_case only",
      truncated: false,
    });
  });

  it("prefers .makorules.md when both exist", async () => {
    const project = await seedProject();
    await seedBase(project, ".makorules.md", "markdown wins");
    await seedBase(project, ".makorules", "bare loses");
    const rules = await resolveDbtRules(project, USER);
    expect(rules?.path).toBe(".makorules.md");
    expect(rules?.contents).toBe("markdown wins");
  });

  it("treats a whitespace-only rules file as absent", async () => {
    const project = await seedProject();
    await seedBase(project, ".makorules.md", "   \n\t\n  ");
    expect(await resolveDbtRules(project, USER)).toBeNull();
  });

  it("falls through to .makorules when .makorules.md is blank", async () => {
    const project = await seedProject();
    await seedBase(project, ".makorules.md", "  \n ");
    await seedBase(project, ".makorules", "- real rules");
    expect((await resolveDbtRules(project, USER))?.path).toBe(".makorules");
  });

  it("lets an uncommitted user draft shadow the committed base", async () => {
    const project = await seedProject();
    await seedBase(project, ".makorules.md", "committed rules");
    await DbtFileDraft.create({
      workspaceId: project.workspaceId,
      projectId: project._id,
      userId: USER,
      branch: "main",
      path: ".makorules.md",
      content: "draft rules",
    });
    expect((await resolveDbtRules(project, USER))?.contents).toBe("draft rules");
  });

  it("truncates oversized rules and flags it", async () => {
    const project = await seedProject();
    await seedBase(project, ".makorules.md", "x".repeat(DBT_RULES_MAX_CHARS + 500));
    const rules = await resolveDbtRules(project, USER);
    expect(rules?.truncated).toBe(true);
    expect(rules?.contents).toHaveLength(DBT_RULES_MAX_CHARS);
  });

  it("exposes the recognized paths in precedence order", () => {
    expect(DBT_RULES_PATHS).toEqual([".makorules.md", ".makorules"]);
  });
});

describe("renderDbtRulesBlock", () => {
  const rules = {
    path: ".makorules.md",
    contents: "- never select *",
    truncated: false,
  };

  it("names the file, the project, and the precedence order", () => {
    const block = renderDbtRulesBlock(rules, "Analytics");
    expect(block).toContain(".makorules.md");
    expect(block).toContain("Analytics");
    expect(block).toContain("- never select *");
    expect(block.toLowerCase()).toContain("binding");
    // Project rules outrank the workspace prompt and the dbt skill.
    expect(block.indexOf("project rules")).toBeLessThan(
      block.indexOf("workspace instructions"),
    );
  });

  it("marks truncated rules explicitly", () => {
    const block = renderDbtRulesBlock({ ...rules, truncated: true }, "Analytics");
    expect(block).toContain("truncated");
    expect(block).toContain(String(DBT_RULES_MAX_CHARS));
  });

  it("does not mark untruncated rules", () => {
    expect(renderDbtRulesBlock(rules, "Analytics")).not.toContain("truncated");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter api run test:dbt -- src/dbt/dbt-rules.service.test.ts`
Expected: FAIL at import — `Failed to resolve import "./dbt-rules.service"`.

- [ ] **Step 3: Write the minimal implementation**

Create `api/src/dbt/dbt-rules.service.ts`:

```ts
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter api run test:dbt -- src/dbt/dbt-rules.service.test.ts`
Expected: PASS, 12 tests.

Note on the precedence assertion: the rendered text contains the literal lowercase substrings `project rules` (in the precedence sentence) and `workspace instructions`, in that order — `block.toLowerCase()` is not needed for `indexOf` here because both appear lowercase in the precedence sentence. If the assertion fails, check the sentence wording rather than loosening the test.

- [ ] **Step 5: Commit**

```bash
git add api/src/dbt/dbt-rules.service.ts api/src/dbt/dbt-rules.service.test.ts
git commit -m "feat(dbt): resolve and render .makorules project rules"
```

---

### Task 3: Turn-level project resolution

Task 2 needs a project handed to it. On a chat turn the agent context has at most a hint (`dbtProjectId` from an open dbt tab, wired in Task 5). This task turns that hint into a rendered block, so `agent.routes.ts` stays thin and the resolution rules are unit-tested.

Resolution order: the hinted project (scoped to the workspace) → the workspace's sole dbt project if there is exactly one → nothing.

**Files:**
- Create: `api/src/dbt/dbt-rules-turn.service.ts`
- Create: `api/src/dbt/dbt-rules-turn.service.test.ts`

**Interfaces:**
- Consumes: `resolveDbtRules`, `renderDbtRulesBlock`, `DbtRules` from `./dbt-rules.service` (Task 2).
- Produces, for Task 6: `resolveDbtRulesBlockForTurn(params: { workspaceId: string; userId?: string; dbtProjectId?: string }): Promise<string>` — the rendered block, or `""` when no project resolves or the project has no rules.

- [ ] **Step 1: Write the failing test**

Create `api/src/dbt/dbt-rules-turn.service.test.ts`:

```ts
/**
 * Turn-level .makorules resolution: hinted project > sole workspace project >
 * nothing. Runs against an ephemeral Mongo so the DbtProject lookups are real.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import mongoose, { Types } from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

import { resolveDbtRulesBlockForTurn } from "./dbt-rules-turn.service";
import {
  DbtFile,
  DbtFileDraft,
  DbtProject,
} from "../database/workspace-schema";

let mongo: MongoMemoryServer;
const WS = new Types.ObjectId();
const OTHER_WS = new Types.ObjectId();
const CONN = new Types.ObjectId();
const USER = "u1";

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

beforeEach(async () => {
  await Promise.all([
    DbtFile.deleteMany({}),
    DbtFileDraft.deleteMany({}),
    DbtProject.deleteMany({}),
  ]);
});

async function seedProject(name: string, workspaceId = WS, rules?: string) {
  const project = await DbtProject.create({
    workspaceId,
    name,
    environments: [
      { name: "dev", connectionId: CONN, targetSchema: "analytics", threads: 4 },
    ],
    defaultEnvironment: "dev",
    createdBy: "tester",
  });
  if (rules !== undefined) {
    await DbtFile.create({
      workspaceId,
      projectId: project._id,
      path: ".makorules.md",
      content: rules,
      updatedBy: "tester",
    });
  }
  return project._id.toString();
}

describe("resolveDbtRulesBlockForTurn", () => {
  it("returns '' when the workspace has no dbt projects", async () => {
    expect(
      await resolveDbtRulesBlockForTurn({
        workspaceId: WS.toString(),
        userId: USER,
      }),
    ).toBe("");
  });

  it("uses the sole workspace project when no hint is given", async () => {
    await seedProject("Analytics", WS, "- never select *");
    const block = await resolveDbtRulesBlockForTurn({
      workspaceId: WS.toString(),
      userId: USER,
    });
    expect(block).toContain("- never select *");
    expect(block).toContain("Analytics");
  });

  it("returns '' with several projects and no hint", async () => {
    await seedProject("Analytics", WS, "- rule a");
    await seedProject("Finance", WS, "- rule b");
    expect(
      await resolveDbtRulesBlockForTurn({
        workspaceId: WS.toString(),
        userId: USER,
      }),
    ).toBe("");
  });

  it("uses the hinted project when several exist", async () => {
    await seedProject("Analytics", WS, "- rule a");
    const financeId = await seedProject("Finance", WS, "- rule b");
    const block = await resolveDbtRulesBlockForTurn({
      workspaceId: WS.toString(),
      userId: USER,
      dbtProjectId: financeId,
    });
    expect(block).toContain("- rule b");
    expect(block).not.toContain("- rule a");
  });

  it("returns '' when the resolved project has no rules file", async () => {
    const id = await seedProject("Analytics", WS);
    expect(
      await resolveDbtRulesBlockForTurn({
        workspaceId: WS.toString(),
        userId: USER,
        dbtProjectId: id,
      }),
    ).toBe("");
  });

  it("never crosses the workspace boundary", async () => {
    const foreignId = await seedProject("Foreign", OTHER_WS, "- leaked");
    expect(
      await resolveDbtRulesBlockForTurn({
        workspaceId: WS.toString(),
        userId: USER,
        dbtProjectId: foreignId,
      }),
    ).toBe("");
  });

  it("returns '' for a malformed project id instead of throwing", async () => {
    await seedProject("Analytics", WS, "- rule a");
    expect(
      await resolveDbtRulesBlockForTurn({
        workspaceId: WS.toString(),
        userId: USER,
        dbtProjectId: "not-an-object-id",
      }),
    ).toBe("");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter api run test:dbt -- src/dbt/dbt-rules-turn.service.test.ts`
Expected: FAIL at import — `Failed to resolve import "./dbt-rules-turn.service"`.

- [ ] **Step 3: Write the minimal implementation**

Create `api/src/dbt/dbt-rules-turn.service.ts`:

```ts
/**
 * Turn-level `.makorules` resolution for the chat agents.
 *
 * A chat turn knows at most which dbt project the user has open (forwarded from
 * the active tab). This resolves that hint — or a workspace with exactly one
 * dbt project — into a rendered rules block. Multi-project workspaces with no
 * open dbt tab get nothing here; the agent still receives the rules inline from
 * `read_dbt_project_tree`, which the dbt workflow makes it call first.
 */

import { Types } from "mongoose";
import { DbtProject, type IDbtProject } from "../database/workspace-schema";
import { renderDbtRulesBlock, resolveDbtRules } from "./dbt-rules.service";

async function resolveProject(
  workspaceId: string,
  dbtProjectId?: string,
): Promise<IDbtProject | null> {
  const workspaceFilter = { workspaceId: new Types.ObjectId(workspaceId) };

  if (dbtProjectId) {
    // A bad id from a stale client must not fail the turn.
    if (!Types.ObjectId.isValid(dbtProjectId)) return null;
    return DbtProject.findOne({
      ...workspaceFilter,
      _id: new Types.ObjectId(dbtProjectId),
    });
  }

  // No hint: unambiguous only when the workspace has exactly one project.
  const projects = await DbtProject.find(workspaceFilter).limit(2);
  return projects.length === 1 ? projects[0] : null;
}

export async function resolveDbtRulesBlockForTurn(params: {
  workspaceId: string;
  userId?: string;
  dbtProjectId?: string;
}): Promise<string> {
  const project = await resolveProject(params.workspaceId, params.dbtProjectId);
  if (!project) return "";

  const rules = await resolveDbtRules(project, params.userId);
  if (!rules) return "";

  return renderDbtRulesBlock(rules, project.name);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter api run test:dbt -- src/dbt/dbt-rules-turn.service.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add api/src/dbt/dbt-rules-turn.service.ts api/src/dbt/dbt-rules-turn.service.test.ts
git commit -m "feat(dbt): resolve .makorules for a chat turn"
```

---

### Task 4: Return rules from `read_dbt_project_tree`

Prompt injection needs a resolvable project. In a multi-project workspace with no open dbt tab there is none — so the orientation tool carries the rules too. The dbt workflow requires calling this tool first, so the rules arrive before any model is written. This modifies an existing tool's **return value only**; no new tool, so no tool-catalog tier work.

**Files:**
- Modify: `api/src/agent-lib/tools/dbt-tools.ts` (imports near the top; the `read_dbt_project_tree` execute body at ~lines 424-443)
- Test: `api/src/agent-lib/tools/dbt-file-tools.test.ts` (extend)

**Interfaces:**
- Consumes: `resolveDbtRules` from `../../dbt/dbt-rules.service` (Task 2).
- Produces: `read_dbt_project_tree` with a `projectId` now returns an optional `rules: { path: string; contents: string }`. The key is **omitted** (not `null`) when no rules file exists.

- [ ] **Step 1: Write the failing test**

Add to `api/src/agent-lib/tools/dbt-file-tools.test.ts`. First add this typed helper next to the existing `readFile` helper (around line 141):

```ts
type TreeResult = {
  success: boolean;
  files?: string[];
  rules?: { path: string; contents: string };
};

function readTree(projectId: string): Promise<TreeResult> {
  return (
    tools.read_dbt_project_tree.execute as (i: {
      projectId: string;
    }) => Promise<TreeResult>
  )({ projectId });
}
```

Then add this describe block at the end of the file:

```ts
describe("read_dbt_project_tree .makorules", () => {
  it("omits the rules key when the project has none", async () => {
    const projectId = await seedRepoProject();
    const tree = await readTree(projectId);
    expect(tree.success).toBe(true);
    expect(tree).not.toHaveProperty("rules");
  });

  it("returns the rules file inline when present", async () => {
    const projectId = await seedRepoProject();
    await DbtFile.create({
      workspaceId: new Types.ObjectId(WS),
      projectId: new Types.ObjectId(projectId),
      branch: "main",
      path: ".makorules.md",
      content: "- never select *",
      updatedBy: "sync",
      repoBlobSha: gitBlobSha("- never select *"),
    });
    const tree = await readTree(projectId);
    expect(tree.rules).toEqual({
      path: ".makorules.md",
      contents: "- never select *",
    });
    // The rules file is still a normal working-tree file.
    expect(tree.files).toContain(".makorules.md");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter api run test:dbt -- src/agent-lib/tools/dbt-file-tools.test.ts`
Expected: the "omits" test PASSES (nothing sets `rules` yet); "returns the rules file inline" FAILS with `expected undefined to deeply equal { path: '.makorules.md', ... }`.

- [ ] **Step 3: Write the minimal implementation**

In `api/src/agent-lib/tools/dbt-tools.ts`, add the import alongside the other `../../dbt/*` imports:

```ts
import { resolveDbtRules } from "../../dbt/dbt-rules.service";
```

Then in the `read_dbt_project_tree` execute body, replace the `Promise.all` and the returned object of the `projectId` branch (currently lines 424-443) with:

```ts
          const project = await assertProject(projectId);
          const [files, jobs, rules] = await Promise.all([
            listWorkingFiles(project, actingUserId),
            DbtJob.find({ projectId: project._id }).lean(),
            resolveDbtRules(project, actingUserId),
          ]);
          return {
            success: true as const,
            projectId,
            name: project.name,
            defaultEnvironment: project.defaultEnvironment,
            environments: project.environments,
            files: files.map(f => f.path),
            // Team-authored rules for this project — binding for any SQL
            // written here. Omitted entirely when the project has none.
            ...(rules
              ? { rules: { path: rules.path, contents: rules.contents } }
              : {}),
            jobs: jobs.map(job => ({
              id: job._id.toString(),
              name: job.name,
              environment: job.environment,
              commands: job.commands,
              schedule: job.schedule ?? null,
              enabled: job.enabled,
            })),
          };
```

Finally extend the tool's `description` so the model knows the field exists — replace the existing description string with:

```ts
      description:
        "List dbt projects in the workspace, or the file tree + jobs of one " +
        "project when projectId is given. Call this FIRST to get project IDs " +
        "and file paths before using any other dbt tool. When the project has " +
        "a .makorules file, its contents come back in `rules` — those are " +
        "binding conventions for any SQL you write in that project.",
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter api run test:dbt -- src/agent-lib/tools/dbt-file-tools.test.ts`
Expected: PASS, including the pre-existing draft/dirty-tracking tests.

- [ ] **Step 5: Commit**

```bash
git add api/src/agent-lib/tools/dbt-tools.ts api/src/agent-lib/tools/dbt-file-tools.test.ts
git commit -m "feat(dbt): return .makorules inline from read_dbt_project_tree"
```

---

### Task 5: Forward the active dbt project id from the client

`buildOpenTabs` already forwards `metadata` fields for dashboard, flow, and notebook tabs but drops `metadata.projectId` for dbt tabs, so the server cannot tell which dbt project the user is looking at. This adds it.

**Files:**
- Modify: `app/src/agent-runtime/request-context.ts:67-90` (`buildOpenTabs`)
- Modify: `api/src/agents/types.ts:86-95` (the `openTabs` element type)
- Test: `app/src/agent-runtime/request-context.test.ts` (extend)

**Interfaces:**
- Consumes: `ConsoleTab.metadata.projectId`, set by `focusDbtFileTab` / `focusDbtConsoleTab` in `app/src/dbt-runtime/shell.ts`.
- Produces, for Task 6: `AgentContext["openTabs"][number].dbtProjectId?: string`, populated for tab kinds `dbt-file`, `dbt-job`, `dbt-console`, `dbt-runs`.

- [ ] **Step 1: Write the failing test**

Add this describe block to `app/src/agent-runtime/request-context.test.ts` (at the end of the outer describe, matching the existing `buildChatRequestBody` call shape):

```ts
  it("forwards the dbt project id for dbt tabs only", () => {
    const requestBody = buildChatRequestBody({
      messages: [],
      workspaceId: "ws_1",
      modelId: "model_1",
      chatId: "chat_1",
      tabs: [
        {
          id: "dbt_1",
          title: "stg_orders.sql",
          content: "",
          kind: "dbt-file",
          metadata: { projectId: "proj_1", path: "models/stg_orders.sql" },
        },
        {
          id: "console_1",
          title: "Revenue Query",
          content: "select 1",
          kind: "console",
          connectionId: "conn_1",
        },
      ] as any,
      activeTabId: "dbt_1",
      activeTab: {
        id: "dbt_1",
        title: "stg_orders.sql",
        content: "",
        kind: "dbt-file",
        metadata: { projectId: "proj_1", path: "models/stg_orders.sql" },
      } as any,
      activeView: "console",
      activeExplorer: "consoles",
      workspaceConnections: [{ id: "conn_1", type: "postgresql" }] as any,
    });

    const tabs = requestBody.openTabs as Array<{
      id: string;
      dbtProjectId?: string;
    }>;
    expect(tabs.find(t => t.id === "dbt_1")?.dbtProjectId).toBe("proj_1");
    expect(tabs.find(t => t.id === "console_1")?.dbtProjectId).toBeUndefined();
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter app run test:unit -- src/agent-runtime/request-context.test.ts`
Expected: FAIL — `expected undefined to be 'proj_1'`.

- [ ] **Step 3: Write the minimal implementation**

In `app/src/agent-runtime/request-context.ts`, add a module-level constant above `buildOpenTabs`:

```ts
/** Tab kinds whose metadata carries a dbt project id. */
const DBT_TAB_KINDS = new Set([
  "dbt-file",
  "dbt-job",
  "dbt-console",
  "dbt-runs",
]);
```

Then add this field inside the object returned by `buildOpenTabs`, after `notebookId`:

```ts
    // Lets the server resolve which dbt project's .makorules govern this turn.
    dbtProjectId: DBT_TAB_KINDS.has(tab.kind || "")
      ? (tab.metadata?.projectId as string | undefined)
      : undefined,
```

In `api/src/agents/types.ts`, add to the `openTabs` element type (after `connectionId?: string;`):

```ts
    /** dbt project the tab belongs to (dbt-file / dbt-job / dbt-console tabs). */
    dbtProjectId?: string;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter app run test:unit -- src/agent-runtime/request-context.test.ts`
Expected: PASS.

Then typecheck both packages: `pnpm --filter app run build && pnpm --filter api run build`
Expected: both succeed.

- [ ] **Step 5: Commit**

```bash
git add app/src/agent-runtime/request-context.ts app/src/agent-runtime/request-context.test.ts api/src/agents/types.ts
git commit -m "feat(dbt): forward the active dbt project id on chat turns"
```

---

### Task 6: Inject the rules block into the prompts

Wire everything together: resolve the block in the route, put it on the agent context, and render it in both consumers' dynamic system message.

**Files:**
- Modify: `api/src/agents/types.ts` (add `dbtRulesBlock`)
- Modify: `api/src/agent-lib/types.ts:51` area (add `dbtRulesBlock`)
- Modify: `api/src/routes/agent.routes.ts` (resolve after the skills block at ~line 657; add to `agentContext` at ~line 719)
- Modify: `api/src/agents/dbt/index.ts:88-96`
- Modify: `api/src/agents/unified/prompt.ts:413-417`
- Create: `api/src/dbt/dbt-rules-prompt-wiring.test.ts`
- Modify: `api/vitest.config.ts` (no change needed — the new test lives under `src/dbt/**`)

**Interfaces:**
- Consumes: `resolveDbtRulesBlockForTurn` from `../dbt/dbt-rules-turn.service` (Task 3); `openTabs[].dbtProjectId` (Task 5).
- Produces: `AgentContext.dbtRulesBlock?: string` — pre-rendered, `""` when absent.

- [ ] **Step 1: Write the failing test**

Create `api/src/dbt/dbt-rules-prompt-wiring.test.ts`. It lives under `src/dbt/**` so the existing vitest include picks it up, and it exercises the two prompt builders directly — no Mongo needed.

```ts
/**
 * The rendered .makorules block must reach BOTH prompt consumers: the
 * standalone dbt agent and the unified prompt (which is what production chat
 * actually resolves to). Regression guard against wiring only one of them.
 */
import { describe, expect, it, vi } from "vitest";

// Tool modules pulled in transitively by the dbt agent factory — inert here.
vi.mock("../services/realtime.service", () => ({
  publishRealtimeEvent: vi.fn(),
}));

import { buildCurrentScreenContext } from "../agents/unified/prompt";
import { dbtAgentFactory } from "../agents/dbt";
import type { AgentContext } from "../agents/types";

const RULES_BLOCK = "### Project rules — `.makorules.md`\n\n- never select *";

function baseContext(overrides: Partial<AgentContext> = {}): AgentContext {
  return {
    workspaceId: "507f1f77bcf86cd799439011",
    activeView: "console",
    userId: "u1",
    ...overrides,
  } as AgentContext;
}

describe("unified prompt", () => {
  it("includes the dbt rules block when present", () => {
    const prompt = buildCurrentScreenContext(
      baseContext({ dbtRulesBlock: RULES_BLOCK }),
    );
    expect(prompt).toContain("- never select *");
  });

  it("omits it when absent or blank", () => {
    expect(buildCurrentScreenContext(baseContext())).not.toContain(
      "Project rules",
    );
    expect(
      buildCurrentScreenContext(baseContext({ dbtRulesBlock: "   " })),
    ).not.toContain("Project rules");
  });
});

describe("dbt agent", () => {
  it("puts the rules block in the dynamic system message, not the cached one", () => {
    const config = dbtAgentFactory(baseContext({ dbtRulesBlock: RULES_BLOCK }));
    const [cached, dynamic] = config.systemPrompt as Array<{
      content: string;
      providerOptions?: unknown;
    }>;
    expect(dynamic.content).toContain("- never select *");
    // The base prompt carries the 1h cache breakpoint — per-project rules
    // must never land there or they poison the cached prefix.
    expect(cached.content).not.toContain("- never select *");
    expect(cached.providerOptions).toBeDefined();
  });

  it("omits the block when the project has no rules", () => {
    const config = dbtAgentFactory(baseContext());
    const dynamic = (config.systemPrompt as Array<{ content: string }>)[1];
    expect(dynamic.content).not.toContain("Project rules");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter api run test:dbt -- src/dbt/dbt-rules-prompt-wiring.test.ts`
Expected: FAIL — TypeScript rejects `dbtRulesBlock` on `AgentContext`, and the "includes" assertions fail.

If instead it fails while *importing* `../agents/dbt` (a transitive module reaching for env vars, a DB handle, or a network client at import time), add a `vi.mock` for that module at the top of the file and re-run. `api/src/agent-lib/tools/dbt-file-tools.test.ts:30-77` is the worked example of which collaborators need stubbing. Only stub what the import chain actually demands — the two prompt builders are the code under test and must stay real.

- [ ] **Step 3: Write the minimal implementation**

**3a.** In `api/src/agents/types.ts`, add next to `workspaceCustomPrompt` (line 112):

```ts
  /**
   * Pre-rendered `.makorules` block for the dbt project this turn is about.
   * Populated by `agent.routes.ts` via `resolveDbtRulesBlockForTurn`. Empty
   * when no project resolves or the project ships no rules file.
   */
  dbtRulesBlock?: string;
```

**3b.** In `api/src/agent-lib/types.ts`, add the same field next to `workspaceCustomPrompt` (line 51):

```ts
  dbtRulesBlock?: string;
```

**3c.** In `api/src/routes/agent.routes.ts`, add the import alongside the other service imports:

```ts
import { resolveDbtRulesBlockForTurn } from "../dbt/dbt-rules-turn.service";
```

Insert this block immediately after the skills-retrieval block (after line 657, before `const dashboardContext = ...`):

```ts
    // `.makorules` — the dbt project's own SQL conventions. Binding for any
    // model the agent writes, so it is injected rather than left for the agent
    // to look up. Never fatal: a failed lookup just means no rules this turn.
    let dbtRulesBlock = "";
    if (resolvedAgentId === "unified" || resolvedAgentId === "dbt") {
      try {
        const dbtTabs = (openTabs ?? []).filter(t => t.dbtProjectId);
        dbtRulesBlock = await resolveDbtRulesBlockForTurn({
          workspaceId,
          userId: actorId,
          dbtProjectId:
            dbtTabs.find(t => t.isActive)?.dbtProjectId ??
            dbtTabs[0]?.dbtProjectId,
        });
      } catch (err) {
        logger.warn("dbt rules injection skipped", { error: err });
      }
    }
```

Add to the `agentContext` object literal, after `skillsBlock,` (line 719):

```ts
      dbtRulesBlock,
```

**3d.** In `api/src/agents/unified/prompt.ts`, insert immediately before the `workspaceCustomPrompt` block (line 413) — project rules render above workspace context, matching their precedence:

```ts
  if (context.dbtRulesBlock?.trim()) {
    // Pre-rendered with its own heading by renderDbtRulesBlock.
    sections.push("");
    sections.push(context.dbtRulesBlock.trim());
  }
```

**3e.** In `api/src/agents/dbt/index.ts`, replace the second system message's `content` expression (lines 90-95) with:

```ts
        content:
          (context.skillsBlock ?? "") +
          (context.dbtRulesBlock?.trim()
            ? `\n\n${context.dbtRulesBlock.trim()}`
            : "") +
          (context.workspaceCustomPrompt
            ? `\n\n## Workspace instructions\n${context.workspaceCustomPrompt}`
            : "") +
          buildRuntimeContext(context),
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter api run test:dbt -- src/dbt/dbt-rules-prompt-wiring.test.ts`
Expected: PASS, 4 tests.

Then the full dbt suite and the tsx suite, to catch prompt-size and tool-tier regressions:

Run: `pnpm --filter api run test:dbt && pnpm --filter api run test`
Expected: both PASS. If `src/agents/prompt-size.test.ts` complains, the rules block was added to a base prompt constant instead of the dynamic message — revisit step 3d/3e.

- [ ] **Step 5: Commit**

```bash
git add api/src/agents/types.ts api/src/agent-lib/types.ts api/src/routes/agent.routes.ts api/src/agents/dbt/index.ts api/src/agents/unified/prompt.ts api/src/dbt/dbt-rules-prompt-wiring.test.ts
git commit -m "feat(dbt): inject .makorules into the dbt and unified prompts"
```

---

### Task 7: Discovery — prompts, skill, docs

Nobody uses a rules file they don't know exists. The agent learns to offer creating one; the docs explain it.

**Files:**
- Modify: `api/src/agents/dbt/prompt.ts` (the `## Rules` list, before the closing backtick at line 69)
- Modify: `api/src/agents/modes/prompts.ts` (`TRANSFORM_MODE_SYSTEM_PROMPT`, from line 147)
- Modify: `api/src/agent-skills/dbt/SKILL.md`
- Modify: `docs/src/content/docs/transforms.md`

**Interfaces:**
- Consumes: the `create_dbt_file` tool (already registered — no tier work).
- Produces: nothing other modules depend on.

- [ ] **Step 1: Add the rule to the dbt agent prompt**

In `api/src/agents/dbt/prompt.ts`, insert these two bullets into the `## Rules` list, immediately after the "Load the \`dbt\` system skill…" bullet (line 66):

```
- A project may ship \`.makorules.md\` (or \`.makorules\`) at its root: team-authored SQL
  conventions. When present its contents are injected into your context and returned by
  \`read_dbt_project_tree\` — treat them as binding, above your own defaults and the \`dbt\`
  skill. If a rule conflicts with what the user asked for, say so and cite the file.
- When a user states a durable convention ("always…", "never…", "we always name…"), offer to
  record it in \`.makorules.md\` with \`create_dbt_file\` (or \`edit_dbt_file\` if it exists) so it
  applies to every future session. Offer — never write it unasked.
```

- [ ] **Step 2: Add the same to the transform mode prompt**

In `api/src/agents/modes/prompts.ts`, append these two sentences to the end of `TRANSFORM_MODE_SYSTEM_PROMPT` (the mode the unified agent actually runs for dbt work):

```
A project may ship \`.makorules.md\` (or \`.makorules\`) at its root — team-authored SQL
conventions, injected into your context and returned by \`read_dbt_project_tree\`. Treat those
rules as binding, above your defaults and the \`dbt\` skill, and cite the file when one conflicts
with a request. When the user states a durable convention, offer to record it there.
```

- [ ] **Step 3: Point the dbt skill at it**

In `api/src/agent-skills/dbt/SKILL.md`, add this near the top, under whatever intro section precedes the materialization guidance:

```markdown
## Project rules override this skill

If the dbt project has a `.makorules.md` (or `.makorules`) file at its root, the
conventions in it win over everything in this skill. Its contents arrive in your
context automatically and in `read_dbt_project_tree`'s `rules` field. Follow this
skill only where the project's rules are silent.
```

- [ ] **Step 4: Document it**

Append this section to `docs/src/content/docs/transforms.md`:

````markdown
## Project rules (`.makorules.md`)

Drop a `.makorules.md` file at the root of a dbt project and Mako's agent will
follow it on every turn — the same idea as `.cursorrules`, scoped to how your
team writes SQL. `.makorules` (no extension) works too; `.makorules.md` wins if
both exist.

It is an ordinary project file, so it is versioned with the project: it syncs
from your repo, commits and pushes with the rest of your changes, and lives on
the branch you wrote it on. Your uncommitted edits apply to your own agent turns
straight away, so you can tune the rules and re-prompt without committing.

**Precedence,** highest first:

1. What you tell the agent in the conversation
2. `.makorules.md`
3. Workspace instructions (Settings → Prompt)
4. The `dbt` system skill
5. Mako's built-in dbt conventions

When a rule blocks what you asked for, the agent says so and cites the file
rather than silently picking a side.

**Size limit:** the first 16,000 characters (~4k tokens) are injected. Past that
the agent is told the file was truncated.

### Example

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

You don't have to write it yourself: tell the agent a convention ("we never use
`select *`") and it will offer to record it for you.
````

- [ ] **Step 5: Verify nothing regressed and commit**

Run: `pnpm --filter api run test && pnpm --filter api run test:dbt`
Expected: PASS. `src/agents/prompt-size.test.ts` guards the base-prompt budget — if it trips, tighten the wording added in steps 1-2.

Run: `pnpm lint:all`
Expected: clean.

```bash
git add api/src/agents/dbt/prompt.ts api/src/agents/modes/prompts.ts api/src/agent-skills/dbt/SKILL.md docs/src/content/docs/transforms.md
git commit -m "docs(dbt): document .makorules and teach the agent to offer it"
```

---

## Final verification

After all seven tasks:

- [ ] `pnpm --filter api run test:dbt` — full dbt vitest suite green
- [ ] `pnpm --filter api run test` — tsx suite green (tool-tier policy, prompt size)
- [ ] `pnpm --filter app run test:unit` — app suite green
- [ ] `pnpm build` — lint + typecheck across the workspace
- [ ] Manual smoke: create `.makorules.md` in a dbt project via the Transforms explorer with a distinctive rule ("prefix every CTE with `cte_`"), open a model tab, ask the agent to write a staging model, confirm it obeys — then delete the file and confirm it stops.
