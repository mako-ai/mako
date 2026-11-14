# Hatchet run detail fixtures

Real answers of Hatchet's `GET /api/v1/stable/workflow-runs/{id}`, captured
on the PR #1218 preview stack (dev Hatchet) on 2026-11-11 from a throwaway
workflow named `RunBindingProof`, kept verbatim. The ids are of a deleted
preview workspace's tenant and carry no access.

- `hatchet-workflow-run.json`: a scheduled run (`* * * * *`, no Mako
  metadata) while its first step `write-first` runs.
- `hatchet-workflow-run-on-failure.json`: the same run while its
  `onFailure` task runs, after `write-first` failed.

What they show and the tests rely on: each task's `actionId` is
`<workflow>:<step>` lowercased (`runbindingproof:write-first`), while the
workflow is named `RunBindingProof`; the run has no `workflowName`; during
the onFailure task the run is still `RUNNING`; and the onFailure task's
`workflowRunExternalId` is the run's id, which is the run a step's pass
names.
