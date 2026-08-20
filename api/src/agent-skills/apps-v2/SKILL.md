---
name: apps-v2
description: Load when building or editing a git-backed Apps v2 app project.
entities:
  - app project
  - apps v2
  - app-v2
  - app2
---

# Apps v2 workflow

Apps v2 is independent from Apps v1. For an `app-v2` or `app-v2-file` tab, use
only `app2_*` tools. Never read or mutate the project with v1 `app_*`,
`create_app`, or `list_open_apps` tools.

## Working model (Cursor-cloud style)

- Every app is a real Vite + React + TypeScript project in a Mako-managed git
  repository. There is a real filesystem and a real shell.
- THIS conversation works on its own git branch (`chat/<chatId>`), forked off
  `main` on first touch. Your accumulated changes are committed automatically
  at the end of every turn — you do not need to commit for durability.
- The user reviews your branch and merges it into `main` from the app's branch
  menu, or you can merge with `app2_merge_to_main` when they ask you to ship.
- Resuming a conversation resumes its branch: the sandbox may be hot, paused
  (E2B resumes it), or dead (it is rebuilt from git with the branch checked
  out at its latest commit). Never assume in-memory state from earlier turns;
  the durable truth is git.

## Tool guidance

1. `app2_list_apps` to resolve the app id, or `app2_create_app` for a new
   private project (full scaffold: package.json, vite.config.ts, src/).
2. Inspect with `app2_status` (branch, uncommitted changes). Locate code with
   `app2_glob` (paths, e.g. `src/**/*.tsx`) and `app2_grep` (contents, regex) —
   both read straight from git so they work even when the sandbox is paused or
   dead. Read files with `app2_read_file` (line-numbered by default, so you can
   anchor edits precisely). `app2_bash` also works for ad-hoc exploration.
3. Edit with `app2_edit_file` (anchored oldString/newString; re-read after a
   failed anchor) or `app2_write_file` for new files / full rewrites. Deletes
   and renames go through `app2_bash` (`rm`, `mv`) — the flush picks them up.
4. `app2_bash` runs real bash in the app's sandbox (E2B microVM). **cwd is the
   app's own folder** (`apps/<slug>`), not the repo root — `package.json` and
   `src/` are right there. `npm install <pkg>`, `npm run build`, `node`,
   `git log/diff/status`. File changes are flushed to the durable WIP snapshot
   after every command. Do NOT `git commit` or `git push` in the shell —
   commits go through `app2_commit` (checkpoints) or the automatic end-of-turn
   commit, and the session has no push credentials by design.
5. Verify with `npm run build` via `app2_bash` before telling the user the
   app works. Build errors come back on stdout/stderr.

## Reporting results honestly

The user can see the app's build panel. Claiming success it contradicts
destroys their trust in everything else you report.

- **If the last build failed, say so.** Never describe an app as working,
  running, live, or ready when `npm run build` exited non-zero. Lead with the
  failure and the actual error line, then what you propose to do about it.
- **Never invent a URL the user can visit.** Each `app2_bash` call is one-shot:
  backgrounding a server (`vite &`, `npm run dev &`) leaves nothing running
  that the user can reach, and its `localhost:5173` banner is not a link that
  works for them. Previews reach the user only through the app's preview
  controls, never through a port you started in the shell.
- **Do not claim the app is visible in a tab** unless a preview actually
  succeeded in this turn.
- If you cannot get it working, say exactly that and describe what you tried.
  A clear failure report is far more useful than optimism.

## Resolving the app id

Call `app2_list_apps` FIRST and use an id it returns. Never guess or infer an
id from context — a fabricated id costs a round-trip per attempt and the
"not found" error looks like a broken app rather than a bad guess. If the list
is empty, there is no app yet: create one with `app2_create_app`.
6. `app2_list_branches` / `app2_merge_to_main` manage the branch model; merge
   only when the user asks for the changes to land on main.

On a WIP conflict error ("advanced concurrently"), re-run `app2_status`, then
re-read affected files and retry — never overwrite blindly; the losing
snapshot is preserved on a recovery ref.

## Data bindings (bindings-as-files)

A binding is ONE file — `bindings/<name>.sql` (name = filename, no manifest):

```sql
-- connection: <workspace connection id>   (required; ids from list_connections)
-- materialization: parquet                (default; only option today)
-- schedule: 0 6 * * *                     (optional cron refresh)
-- dbt_project: <id>                       (optional)
SELECT ...
```

Front matter is a leading block of `-- key: value` SQL comments; the first
SQL line ends it. Keep queries read-only SELECTs. Build the artifact with
`app2_materialize` (appId + binding name) — it reads THIS conversation's
branch, so it works before merging to main; errors come back verbatim
(fix the SQL and retry). At runtime the preview
serves each artifact at the APP-RELATIVE URL `__data/<name>.parquet`
(no leading slash — use `new URL("__data/x.parquet", document.baseURI)`).
Fetch and read with hyparquet or duckdb-wasm; artifacts are
SNAPPY-compressed, so plain hyparquet works (no compressors bundle needed).
