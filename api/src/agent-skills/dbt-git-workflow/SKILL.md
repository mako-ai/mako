---
name: dbt-git-workflow
description: Load for dbt branches, commits, pushes, pull requests, merges, repository sync, or branch cleanup.
entities:
  - dbt git
  - branch
  - commit
  - push
  - pull request
  - PR
  - merge
  - checkout
  - repository
---

# dbt Git workflow

dbt file edits live in the acting user's working tree and are never pushed
automatically. Read `dbt_git_status` before shipping and preserve unrelated
pending files by passing an explicit `paths` list.

## Required flow

1. Edit and validate the working tree with `dbt_parse`,
   `dbt_compile_model`, and `dbt_run_model`.
2. If the user wants a new review branch, use `dbt_commit_to_branch`. It is an
   atomic branch-and-commit operation; do not compose `dbt_create_branch` with
   `dbt_commit_and_push`.
3. Open the PR with `dbt_open_pull_request`.
4. Before merge, check `dbt_git_status` so intended drafts are not omitted.
5. Merge only when the user asks, using `dbt_merge_pull_request`.
6. Run the production job only after merge and explicit confirmation.

For an existing tracked branch, use `dbt_commit_and_push` only after the user
asks to commit. Omit the message to use Mako's generated commit message.

## Branch safety

- Drafts are isolated per user and branch. Switching branches preserves each
  branch's work.
- `discardLocalChanges` abandons the current branch's pending work. Use it only
  when the approved plan explicitly includes that discard.
- Before deleting a branch, call `dbt_compare_branches`. Delete automatically
  only when `fullyMergedIntoBase` is true; otherwise require explicit
  destructive approval.
- `dbt_sync_from_repo` may discard local changes when requested. Inspect status
  first and never discard implicitly.
- Recover missing work with `dbt_list_recoverable_files` and
  `dbt_restore_file`.

## Pull-request safety

- PR operations ship committed work only; they never include drafts.
- Preserve existing admin/owner checks for merge, update, and close.
- Closing a PR or deleting its branch is destructive and must be present in the
  approved plan.
