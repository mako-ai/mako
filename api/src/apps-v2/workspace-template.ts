/**
 * The starter content of a workspace repo — what every newly initialized
 * workspace clones into existence (apps-v2.md §10).
 *
 * A workspace repo is born with the folder contract, an AGENTS.md that gives
 * any coding agent (Mako's box agent, Claude Code on a laptop clone, anything
 * that reads the emerging AGENTS.md convention) the context it needs, and a
 * skills/ folder with the format documented and one suppressed example.
 *
 * Template = a flat map of path → contents, same shape as the app scaffold
 * (scaffold.ts) and appSdkFiles(). The full seed for `initRepo` is
 * `workspaceSeedFiles()`; the migration and the first-skill adoption path use
 * `workspaceTemplateFiles()` to backfill repos that predate the template
 * without touching the SDK or .gitignore they already have.
 */
import { appSdkFiles } from "./app-sdk-package";
import { workspaceRootGitignore } from "./box";
import { serializeSkillFile, SKILLS_README_PATH } from "./skill-files";

export const WORKSPACE_README = `# Mako workspace

Managed by Mako — the versioned home of everything this team builds there.
Apps live under apps/<name>, workspace skills under skills/<name>/SKILL.md;
consoles and dbt content will join as sibling folders (apps-v2.md §10).

See AGENTS.md for the layout contract and conventions.
`;

const WORKSPACE_AGENTS_MD = `# AGENTS.md — Mako workspace

This repository is a **Mako workspace**: the git-versioned home of everything
a team builds in Mako, an AI-native SQL client, ETL / data-warehouse tool and
data-app builder. Mako itself manages this repo — its UI, agents and sandboxes
all read and write it through the same git remote you are on — so the layout
below is a contract with the product, not a suggestion.

## Layout

- \`apps/<slug>/\` — a data app (Vite + React + TypeScript). The folder IS the
  app: \`apps/<slug>/mako.json\` is its manifest, and creating or deleting the
  folder creates or deletes the app. Data access goes through
  \`bindings/<name>.sql\` files inside the app (SQL with \`-- connection: <id>\`
  comment front matter) read via the \`@mako/app-sdk\` package.
- \`skills/<name>/SKILL.md\` — a workspace skill: a durable playbook the Mako
  agent auto-loads in future sessions when its trigger matches. See
  \`skills/README.md\` for the format. Editing these files here is a
  first-class way to teach the agent.
- \`packages/app-sdk/\` — the \`@mako/app-sdk\` package every app resolves via a
  \`file:\` dependency. Managed by Mako; do not edit.
- \`consoles/\`, \`dbt/\` — reserved for upcoming Mako content types.

## Working in this repo

- \`main\` is live: commits that land on it are what the workspace's members
  and the Mako agent see. Push through \`origin\` (Mako's git endpoint) — every
  push syncs the UI, the agent's skill index, and the durable mirror
  automatically. Do not force-push or delete \`main\`.
- Commit early and often. Uncommitted work exists only in your working copy;
  pushed commits survive it.
- Never commit secrets. \`.env\` and build output are ignored by the root
  \`.gitignore\`; keep it that way.
- Keep changes scoped: one app or skill per commit reads best in the
  workspace's history, which doubles as its audit log.

## Working with skills (for agents)

When you learn something durable about this workspace — a schema fact, a
gotcha, a query pattern, a business definition — record it as a skill instead
of leaving it in conversation history. Keep each skill small and single-topic,
write its \`description\` as the trigger that should load it, and prefer
editing an existing skill over creating a near-duplicate.
`;

const SKILLS_README_MD = `# Workspace skills

A skill is a folder: \`skills/<name>/SKILL.md\`. The Mako agent indexes every
skill here and auto-loads the relevant ones each turn; suppressed skills stay
out of the index but keep their history.

Format (\`<name>\` is lowercase snake_case and must match the folder):

    ---
    name: revenue_definitions
    description: Computing MRR/ARR or answering revenue questions.
    entities: [mrr, arr, revenue]   # optional retrieval triggers
    suppressed: true                # optional — hide from the agent
    ---
    The playbook body: schema facts, gotchas, query patterns, IDs.

Guidelines:

- \`description\` is the retrieval trigger — write it as "load when …", not as
  a summary of the body.
- Keep bodies compact and structured (bullets and examples over prose), one
  topic per skill.
- Delete or fix skills that turn out to be wrong; a bad skill poisons every
  future session that loads it.

Skills are ordinary repo content: edit them here, in the Mako settings UI, or
let the agent save them with \`save_skill\` — all three converge on this folder.
`;

/**
 * A suppressed example so the folder demonstrates its own format without ever
 * entering the agent's retrieval index.
 */
const EXAMPLE_SKILL = serializeSkillFile({
  name: "example_skill",
  loadWhen:
    "Never — this is a suppressed example of the skill format. Copy this folder to write a real skill.",
  entities: [],
  suppressed: true,
  body: `This is what a skill body looks like: the playbook the agent gets when
the skill loads.

- State facts the agent cannot infer (table meanings, business definitions).
- Include working query patterns and concrete IDs where they help.
- Keep it under a few hundred lines; split unrelated topics into other skills.

Delete this example whenever you like.`,
});

/**
 * The Mako-authored starter content: docs + skills folder. Safe to layer onto
 * existing repos file-by-file (the migration writes only the paths a repo is
 * missing).
 */
export function workspaceTemplateFiles(): Record<string, string> {
  return {
    "README.md": WORKSPACE_README,
    "AGENTS.md": WORKSPACE_AGENTS_MD,
    // Claude Code reads CLAUDE.md by name; keep it a pointer, not a fork.
    "CLAUDE.md": "See AGENTS.md.\n",
    [SKILLS_README_PATH]: SKILLS_README_MD,
    "skills/example_skill/SKILL.md": EXAMPLE_SKILL,
  };
}

/** Everything a brand-new workspace repo's initial commit contains. */
export function workspaceSeedFiles(): Record<string, string> {
  return {
    ...workspaceTemplateFiles(),
    // The @mako/app-sdk package, so `import { useQuery } from
    // "@mako/app-sdk"` resolves in every app via a file: dependency —
    // in vite dev, in npm run build, and in a laptop clone alike.
    ...appSdkFiles(),
    // The root .gitignore is the guarantee that EVERY app — scaffolded,
    // hand-built by an agent, or pushed from a laptop — ignores what
    // must never be committed. Per-app .gitignores and the sandbox's
    // info/exclude are refinements; this is the one that is versioned.
    ".gitignore": workspaceRootGitignore(),
  };
}
