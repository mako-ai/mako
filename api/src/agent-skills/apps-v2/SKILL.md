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
`create_app`, `open_app`, `run_app`, or `list_open_apps` tools — they cannot
see git-backed apps at all.

## Working model

- Every app is a real Vite + React + TypeScript project in a Mako-managed git
  repository. There is a real filesystem, a real shell, and a real git remote:
  the sandbox is an ordinary clone that fetches and pushes.
- You work on THE USER'S branch (`user/<id>`), the same one they edit from the
  UI and the terminal — a conversation is not a line of work, so it does not
  get a branch of its own. Your accumulated changes are committed and pushed
  automatically at the end of every turn; committed-and-pushed work survives
  the sandbox dying, uncommitted work lives only in the working copy, exactly
  as on a laptop.
- The user merges their branch into `main` from the branch menu, or you can
  merge with `app2_merge_to_main` when they ask you to ship.
- The sandbox may be hot, paused (E2B resumes it), or dead (a fresh clone
  replaces it). Never assume in-memory state from earlier turns; the durable
  truth is what reached the server.

## The core loop: edit → look → report what you SAW

You have real eyes on the running app. Use them — never reason about what the
app "should" render when you can check what it DOES render.

1. **Put the app on the user's screen**: `app2_open_app` opens its tab in the
   user's Mako UI and starts the live dev session (vite + HMR). Call it after
   creating an app, and whenever the user asks to see one. It returns the dev
   preview URL. If the dev server is wedged or must pick up new behavior,
   pass `restart: true` — otherwise a running server is reused.
2. **Edit** with the file tools. While the dev session runs, saved edits
   hot-reload in the user's preview instantly — no rebuild step, nothing else
   to call.
3. **Look at the result**: `app2_browse` drives a real headless browser
   INSIDE the sandbox — it navigates, clicks, types, evaluates JS, and
   returns console output, page errors, failed requests, and a screenshot
   you can SEE. First use in a fresh sandbox installs the browser (~1 min);
   later calls are fast. It requires a running dev session.
4. **When something is broken or blank**, read `app2_dev_log` FIRST — it is
   the cheapest signal. `devLog` is the dev server's own output (vite boot,
   compile errors, HMR activity); `browserConsole` is what the app's runtime
   reported from any live preview (console.error/warn, uncaught errors,
   unhandled rejections) since the dev session started. A compile error
   lives in `devLog`; a white screen usually lives in `browserConsole`.
5. **Report only what you verified.** An edit is not "applied" because the
   tool returned success — it is applied when you saw it: an HMR line for
   the file in `app2_dev_log`, the change in a re-read of the file, or the
   new state in an `app2_browse` screenshot. If you claim "the badge now
   says v2", a screenshot must have shown v2.

For an app with NO dev session running, `npm run build` via `app2_bash` is
the correctness check before telling the user it works. When a dev session IS
running, prefer looking (`app2_browse`) — it verifies runtime behavior, not
just compilation.

## Tool guidance

1. `app2_list_apps` to resolve the app id, or `app2_create_app` for a new
   private project (full scaffold: package.json, vite.config.ts, src/).
   After creating, `app2_open_app` so the user watches it live.
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
   `git log/diff/status`. The sandbox has a real remote with credentials, so
   `git commit` and `git push` in the shell are legitimate — commits you make
   there are auto-pushed after the command. Prefer `app2_commit` for
   checkpoints (it commits AND pushes in one step) and rely on the automatic
   end-of-turn commit for everything else.
5. Dev servers are managed by `app2_open_app`, not by the shell: do NOT
   background `vite` or `npm run dev` from `app2_bash` — a shell-started
   server is invisible to the preview controls and gets replaced. If
   `app2_open_app` fails on missing dependencies, run `npm install` via
   `app2_bash` and call `app2_open_app` again.
6. `app2_list_branches` / `app2_merge_to_main` manage the branch model; merge
   only when the user asks for the changes to land on main.

If a commit or push is refused (someone else pushed first, or git names files
a checkout would clobber), re-run `app2_status`, re-read the affected files,
and resolve the way a developer would — never overwrite blindly. git's own
message says which files are involved.

## Reporting results honestly

The user is often watching the same live preview you are inspecting.
Claiming success it contradicts destroys their trust in everything else you
report.

- **If the build or dev server failed, say so.** Never describe an app as
  working, running, live, or ready when the evidence says otherwise. Lead
  with the failure and the actual error line (from `app2_dev_log` or the
  build output), then what you propose to do about it.
- **State your evidence.** "The chart renders (verified with a screenshot)"
  or "HMR applied the edit at 09:14" — not bare assertions.
- If you cannot get it working, say exactly that and describe what you tried.
  A clear failure report is far more useful than optimism.

## Resolving the app id

Call `app2_list_apps` FIRST and use an id it returns. Never guess or infer an
id from context — a fabricated id costs a round-trip per attempt and the
"not found" error looks like a broken app rather than a bad guess. If the list
is empty, there is no app yet: create one with `app2_create_app`.

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
`app2_materialize` (appId + binding name) — it reads the working branch, so
it works before merging to main; errors come back verbatim
(fix the SQL and retry). At runtime the preview
serves each artifact at the APP-RELATIVE URL `__data/<name>.parquet`
(no leading slash — use `new URL("__data/x.parquet", document.baseURI)`).
Fetch and read with hyparquet or duckdb-wasm; artifacts are
SNAPPY-compressed, so plain hyparquet works (no compressors bundle needed).
After wiring a binding into the UI, `app2_browse` is how you confirm the data
actually loads — a failed `__data/...` fetch shows up in its failedRequests.
