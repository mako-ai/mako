/**
 * The workspace template — what every workspace repo carries besides its
 * apps, so that `git clone && claude` (or Codex, or Cursor) is Mako-capable
 * with no CLI and no Mako tab (apps.md §11.3, §15).
 *
 * Two kinds of file:
 *
 * - MANAGED: written by Mako, overwritten on every refresh, headed "managed by
 *   Mako". Agent instructions (`AGENTS.md`, imported by `CLAUDE.md`), the MCP
 *   wiring (`.mcp.json`, `.envrc`), the identity stamp
 *   (`.mako/workspace.json`), and the vendored `packages/app-sdk`.
 * - SEEDED: written once when missing, never touched again (`README.md`,
 *   `.gitignore`) — they are the user's after that.
 *
 * Instructions here are POINTERS, not knowledge: the system skills (SDK API,
 * charts, dialects) stay behind the MCP server's `get_relevant_skills`, so
 * there is one copy to maintain instead of one per workspace that drifts.
 *
 * Refresh is monotonic on `templateVersion`: a repo is only ever moved
 * FORWARD, so two API deployments on different versions (dev and prod share
 * a connected repo) cannot ping-pong. Bump WORKSPACE_TEMPLATE_VERSION when
 * any managed content changes — the test pins the fingerprint so forgetting
 * fails CI rather than silently leaving repos stale.
 */
import { createHash } from "node:crypto";
import { loggers } from "../logging";
import { appSdkFiles } from "./app-sdk-package";
import { workspaceRootGitignore } from "./box";
import { readBlob, resolveCommit } from "./repository.service";
import { fetchFromCloud, queueMirrorPush } from "./cloud-repo.service";

const logger = loggers.app();

export const WORKSPACE_TEMPLATE_VERSION = 3;

/** Where `.mcp.json` points when MAKO_API_URL is not exported. */
export const HOSTED_MAKO_URL = "https://app.mako.ai";

export const WORKSPACE_STAMP_PATH = ".mako/workspace.json";

export interface WorkspaceStamp {
  workspaceId: string;
  templateVersion: number;
}

const AGENTS_MD = `# Mako workspace

<!-- managed by Mako: overwritten on template refresh. Put your own guidance
     in README.md or in skills/ (coming), not here. -->

This repository is a Mako workspace: one git monorepo holding every data app
of the workspace. **\`main\` is production** — a commit on \`main\` deploys.

## Layout

- \`apps/<slug>/\` — one app per folder: a real Vite + React + TypeScript
  project. \`mako.json\` (title, entry), \`bindings/<name>.sql\` (data),
  \`src/\`, \`package.json\` + \`package-lock.json\` (commit the lockfile).
- \`packages/app-sdk/\` — \`@mako/app-sdk\` (managed by Mako, do not edit).
  Apps depend on it via \`file:../../packages/app-sdk\`.
- \`.mako/workspace.json\` — workspace id + template version (managed).
- \`.mcp.json\` — the \`mako\` MCP server for your agent (managed).

## Credentials (once per machine)

Two things need to reach Mako: your coding agent (over MCP) and the app's
local dev server (for data). Both sign in with your Mako account — no key to
paste:

1. \`claude\` (or Cursor / Codex) → the \`mako\` MCP server in \`.mcp.json\`
   opens a browser sign-in on first use: pick this workspace, approve
   (read-only). Claude Code: type \`/mcp\` if it does not prompt.
2. \`npx @mako/cli login\` (or \`mako login\` once installed) in this checkout —
   the same sign-in, kept in \`~/.mako/credentials.json\` for \`vite dev\`.

Headless / CI instead: create a workspace API key in Mako (**Workspace
Settings → API Keys**, scopes \`mcp\` + \`query:read\`) and put it in a
\`.env\` at the repo root (gitignored): \`MAKO_API_KEY=revops_…\` — the FULL
key shown once at creation. Then \`claude mcp add --transport http mako
$MAKO_API_URL/api/mcp --header "Authorization: Bearer $MAKO_API_KEY"\`.
An API key, when present, is used instead of the login everywhere.

Self-hosted Mako: set \`MAKO_API_URL\` (\`.env\`, exported — \`.envrc\` does it
for direnv users) so \`.mcp.json\` and the dev server point at your host.

## How to work here

You are an ordinary developer in an ordinary checkout.

- **Files**: edit with YOUR tools (Read/Edit/Bash) in this checkout. The
  \`app_*\` file tools on the MCP server (\`app_write_file\`, \`app_edit_file\`,
  \`app_bash\`, \`app_commit\`, …) act on Mako's *cloud sandbox copy* of the
  repo, not on this checkout — do not use them for file work here.
- **Data**: the \`mako\` MCP server is the only way to the warehouse.
  \`list_connections\` → \`list_tables\` / \`inspect_table\` →
  \`sql_execute_query\` (read-only). Validate every query there BEFORE it
  goes into a binding.
- **Skills**: call \`get_relevant_skills({ query })\` before writing app code.
  The SDK API (\`useQuery\`, \`useDuckDB\`), binding front matter, chart and
  dialect guidance live there — not in this file. \`load_skill("apps")\` is
  the one to read first.
- **Eyes**: run the app yourself — \`npm install && npm run dev\` inside
  \`apps/<slug>\` — and look at it with your own browser tooling. \`run_app\`,
  \`app_open_app\`, \`app_browse\` render the sandbox's checkout, not yours.
- **Memory**: durable workspace knowledge (schema quirks, conventions) goes
  to Mako via \`read_self_directive\` / \`update_self_directive\`, where every
  session and every teammate sees it — not to files local to this machine.

## Data in local dev

Each app's \`vite.config.ts\` includes \`makoData()\` from
\`@mako/app-sdk/vite\`. During \`vite dev\` it answers
\`__data/index.json\` (the app's \`bindings/*.sql\`) and
\`__data/<name>.parquet\` by streaming the binding's materialized artifact
from the Mako API with your login (or the key in \`.env\`); a binding that was never
materialized is built on first request. Results are cached under
\`node_modules/.mako-data/\` for 5 minutes (\`?refresh\` bypasses).

No key → the app runs and every binding answers 503 with a hint. An app whose
\`vite.config.ts\` predates the plugin: add
\`import { makoData } from "@mako/app-sdk/vite";\` and \`makoData()\` to
\`plugins\`.

## Bindings

\`bindings/<name>.sql\` = one query with front matter comments:

\`\`\`sql
-- connection: <connection id from list_connections>
-- materialization: parquet        # or: live
-- schedule: 0 6 * * *             # cron, for parquet
SELECT …
\`\`\`

\`useQuery("<name>")\` in the app reads it. Materialize on demand with the
\`app_materialize\` tool (safe from a checkout: it builds from the committed
binding, keyed by content) or let the dev server do it on first load.

## Shipping

Commit on a branch, push, open a PR — or push to \`main\` to deploy directly.
Mako builds \`main\` and serves the app at \`/apps/<slug>\` for the workspace.
Uncommitted work exists only on this machine.

## Never

- commit \`.env\`, \`node_modules/\`, \`dist/\`, or parquet files;
- put a query in a binding that you did not run with \`sql_execute_query\`;
- edit \`packages/app-sdk/\`, \`.mako/\`, \`.mcp.json\` or this file — they are
  overwritten on refresh.
`;

const CLAUDE_MD = `@AGENTS.md
`;

const MCP_JSON = `${JSON.stringify(
  {
    mcpServers: {
      mako: {
        type: "http",
        url: `\${MAKO_API_URL:-${HOSTED_MAKO_URL}}/api/mcp`,
      },
    },
  },
  null,
  2,
)}\n`;

const ENVRC = `# managed by Mako — loads the gitignored .env (MAKO_API_URL, MAKO_API_KEY)
# for the mako MCP server in .mcp.json. Run \`direnv allow\` once.
dotenv_if_exists
`;

const README_MD = `# Mako workspace

Managed by Mako. Apps live under \`apps/<slug>\`; consoles, skills and dbt
content will join as sibling folders.

Working from a clone? Read \`AGENTS.md\` — it is written for your coding
agent, and it tells you where the credentials go.
`;

function stamp(workspaceId: string): string {
  const value: WorkspaceStamp = {
    workspaceId,
    templateVersion: WORKSPACE_TEMPLATE_VERSION,
  };
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** Files Mako owns: rewritten on every refresh. */
export function managedTemplateFiles(
  workspaceId: string,
): Record<string, string> {
  return {
    "AGENTS.md": AGENTS_MD,
    "CLAUDE.md": CLAUDE_MD,
    ".mcp.json": MCP_JSON,
    ".envrc": ENVRC,
    [WORKSPACE_STAMP_PATH]: stamp(workspaceId),
    ...appSdkFiles(),
  };
}

/** Files written once when absent; the user's from then on. */
export function seededTemplateFiles(): Record<string, string> {
  return {
    "README.md": README_MD,
    ".gitignore": workspaceRootGitignore(),
  };
}

/** Everything a brand-new repo starts with. */
export function initialWorkspaceFiles(
  workspaceId: string,
): Record<string, string> {
  return { ...seededTemplateFiles(), ...managedTemplateFiles(workspaceId) };
}

/**
 * Content hash of the managed files (workspace id held constant). Pinned by
 * the test: when it moves, WORKSPACE_TEMPLATE_VERSION must move with it.
 */
export function templateFingerprint(): string {
  const files = managedTemplateFiles("<workspaceId>");
  const hash = createHash("sha256");
  for (const key of Object.keys(files).sort()) {
    hash.update(key).update("\0").update(files[key]).update("\0");
  }
  return hash.digest("hex").slice(0, 16);
}

async function readAt(
  repoDir: string,
  ref: string,
  relPath: string,
): Promise<string | null> {
  try {
    const blob = await readBlob(repoDir, ref, relPath);
    return blob.isBinary ? null : blob.contents;
  } catch {
    return null;
  }
}

export async function readWorkspaceStamp(
  repoDir: string,
  ref = "refs/heads/main",
): Promise<WorkspaceStamp | null> {
  const raw = await readAt(repoDir, ref, WORKSPACE_STAMP_PATH);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<WorkspaceStamp>;
    if (typeof parsed.templateVersion !== "number") return null;
    return {
      workspaceId: String(parsed.workspaceId ?? ""),
      templateVersion: parsed.templateVersion,
    };
  } catch {
    return null;
  }
}

/**
 * The writes that bring `main` up to the current template, or null when the
 * repo is already current (or has no `main`). Pure with respect to the repo:
 * nothing is committed here.
 */
export async function planTemplateRefresh(
  repoDir: string,
  workspaceId: string,
): Promise<Record<string, string> | null> {
  const ref = "refs/heads/main";
  if (!(await resolveCommit(repoDir, ref))) return null;
  const current = await readWorkspaceStamp(repoDir, ref);
  if (current && current.templateVersion >= WORKSPACE_TEMPLATE_VERSION) {
    return null;
  }

  const writes: Record<string, string> = {
    ...managedTemplateFiles(workspaceId),
  };
  for (const [rel, contents] of Object.entries(seededTemplateFiles())) {
    if ((await readAt(repoDir, ref, rel)) === null) writes[rel] = contents;
  }

  // Deliberately NOTHING under apps/: a refresh must never touch an app
  // folder, because prod rebuilds every published app whose folder changed on
  // main (deploy-on-push). The first refresh upgraded 58 vite configs in one
  // commit and fanned 38 rebuilds out to prod for a dev-only change (§15.4).
  // New apps get makoData() from the scaffold; AGENTS.md gives the one-line
  // by-hand path for older ones.

  // Never rewrite a file to what it already is.
  for (const [rel, contents] of Object.entries(writes)) {
    if ((await readAt(repoDir, ref, rel)) === contents) delete writes[rel];
  }
  return Object.keys(writes).length > 0 ? writes : null;
}

/**
 * Bring a workspace repo's `main` up to the current template with one
 * Mako-authored commit, then queue the mirror push. Returns the commit oid,
 * or null when nothing needed doing.
 */
export async function ensureWorkspaceTemplate(
  workspaceId: string,
  repoDir: string,
): Promise<string | null> {
  // The bare repo is a cache of the mirror; a laptop push or another API
  // deployment (dev and prod can share one connected repo) may have moved
  // `main` since we last looked. Write on top of the mirror's head, or the
  // push is rejected as non-fast-forward and the refresh strands a commit.
  await fetchFromCloud(workspaceId, "main").catch(error => {
    logger.warn("Apps workspace template: mirror fetch failed; continuing", {
      workspaceId,
      error: error instanceof Error ? error.message : String(error),
    });
  });
  const writes = await planTemplateRefresh(repoDir, workspaceId);
  if (!writes) return null;
  // Lazy import: worktree.service imports this module for initRepo.
  const { commitFilesOnBranch } = await import("./worktree.service");
  const { commitOid } = await commitFilesOnBranch(
    repoDir,
    "main",
    { writes },
    {
      message: `Update Mako workspace template to v${WORKSPACE_TEMPLATE_VERSION}`,
    },
  );
  queueMirrorPush(workspaceId);
  logger.info("Apps workspace template refreshed", {
    workspaceId,
    version: WORKSPACE_TEMPLATE_VERSION,
    files: Object.keys(writes).length,
  });
  return commitOid;
}

const REFRESH_INTERVAL_MS = 60 * 60 * 1000;
const lastChecked = new Map<string, number>();

/**
 * Fire-and-forget refresh, at most hourly per workspace per process. Called
 * from hot read paths (the apps list) so any workspace someone is looking at
 * gets — and stays — current, without the read waiting on git.
 */
export function ensureWorkspaceTemplateSoon(
  workspaceId: string,
  repoDir: string,
): void {
  const now = Date.now();
  const last = lastChecked.get(workspaceId) ?? 0;
  if (now - last < REFRESH_INTERVAL_MS) return;
  lastChecked.set(workspaceId, now);
  void ensureWorkspaceTemplate(workspaceId, repoDir).catch(error => {
    lastChecked.delete(workspaceId);
    logger.warn("Apps workspace template refresh failed", {
      workspaceId,
      error: error instanceof Error ? error.message : String(error),
    });
  });
}
