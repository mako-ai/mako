---
name: apps-v2
description: Load when building or editing a Git-backed Apps v2 App Project.
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

1. Use `app2_list_apps` to resolve the `projectId`, or `app2_create_app` to
   create a private Git-backed project.
2. Inspect files with `app2_status` and `app2_read_file`.
3. Prefer `app2_edit_file` for exact anchored edits. Re-read after a failed
   anchor. Use `app2_write_file` for new files or full rewrites, and the
   dedicated delete/move tools for those operations.
4. Use `app2_install_packages` for public npm registry packages. It rejects
   URLs, Git sources, local paths, and shell syntax.
5. Use `app2_bash` for finite development commands. It runs real
   `bash -lc` semantics in the secure sandbox and flushes captured source back
   to the durable worktree. If the provider is unavailable, file and Git tools
   still work.
6. Check `app2_status` after changes. Call `app2_commit` only when the user
   asks for a durable branch checkpoint.

The personal WIP ref is durable after each successful mutation. Every write,
shell capture, install, and commit uses revision/WIP/lease compare-and-swap.
Never work around a conflict by overwriting current state; re-read and retry.
A shell/install result may report a recovery ref when source capture succeeded
but the WIP flush conflicted. Report that recovery state instead of claiming
the source was committed.
