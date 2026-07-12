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
6. Check `app2_status` after changes. Each outer chat turn automatically
   commits dirty projects to that chat's `mako/chat/<chat-id>` branch. Call
   `app2_commit` only when the user explicitly asks for an earlier checkpoint.
   When the project has an automatic GitHub mirror, turn finalization pushes
   that exact local commit after it is durable. A mirror failure never rolls
   back or replaces the mako-git commit and can be retried separately.

Each chat has a separate agent worktree and branch per project; the manual UI
worktree remains separate. A next turn reuses a running or paused sandbox. If
the sandbox is gone, it is recreated from the approved template and the
conversation branch/private WIP snapshot. The personal WIP ref is durable after
each successful mutation. Every write, shell capture, install, and commit uses
revision/WIP/lease compare-and-swap.
GitHub credentials stay in the control plane. Never request, print, persist, or
copy an installation token into the sandbox.
Never work around a conflict by overwriting current state; re-read and retry.
A shell/install result may report a recovery ref when source capture succeeded
but the WIP flush conflicted. Report that recovery state instead of claiming
the source was committed.

Outer turns durably own the exact worktree revision they touch. If a prior turn
still owns dirty WIP, stop and report the retryable conflict; do not bypass the
fence. Turn finalization retries unsynced/error session recovery before commit
and never commits an older revision after a failed or conflicting flush. A
crash-orphaned WIP can be adopted only after durable metadata proves no active
prior turn owns it.
