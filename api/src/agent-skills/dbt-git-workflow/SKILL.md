---
name: dbt-git-workflow
description: Load for dbt branches, commits, merges, deploys, or questions about where dbt files live.
entities:
  - dbt git
  - branch
  - commit
  - merge
  - checkout
  - repository
---

# dbt Git workflow

dbt files are the `dbt/` folder of the ONE workspace repository (the same
repo that holds apps, consoles and skills). Every dbt file edit made through
Mako — yours or a user's — IS a commit on the acting user's SESSION branch,
authored as them, pushed to the workspace repo's mirror automatically. There
are no dbt-specific git tools any more.

## The model

- **Session branch**: the same branch pointer the Source Control rail and
  `git checkout` in an apps terminal move. Everyone defaults to `main`;
  switching branches in Source Control switches what dbt reads and writes.
- **Deploy = merge to main**: jobs and scheduled runs build the DEFAULT
  branch. Work on a feature branch reaches production when the user merges
  it (Source Control rail "Merge into main", or an ordinary PR on the
  connected GitHub repo). Never merge proactively.
- **Verification**: `dbt_parse` / `dbt_compile_model` / `dbt_run_model`
  build the acting user's session branch — since every save commits, what
  you see is what builds.
- **History and recovery**: ordinary git. Diffs, blame and restores live in
  the Source Control rail; nothing is ever lost while it was committed —
  which, here, is always.

## Safety

- Prod-like environments refuse ad-hoc warehouse writes on every project;
  deploys go through jobs after a merge to main.
- Do not commit to main what the user asked to keep on a branch: check which
  branch the session is on before large edit runs when the user mentioned
  review or branches.
