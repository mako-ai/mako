import assert from "node:assert/strict";
import { deriveAppV2ProjectionRepair } from "./projection-repair";

const head = "b".repeat(40);
const staleHead = "a".repeat(40);
const dirtyWip = "c".repeat(40);

assert.deepEqual(
  deriveAppV2ProjectionRepair({
    projectHeadSha: staleHead,
    worktreeBaseSha: staleHead,
    worktreeWipOid: staleHead,
    actualHeadSha: head,
    actualWipOid: head,
  }),
  {
    projectHeadSha: head,
    worktreeBaseSha: head,
    worktreeWipOid: head,
    projectChanged: true,
    worktreeChanged: true,
  },
);

assert.deepEqual(
  deriveAppV2ProjectionRepair({
    projectHeadSha: head,
    worktreeBaseSha: staleHead,
    worktreeWipOid: dirtyWip,
    actualHeadSha: head,
    actualWipOid: dirtyWip,
  }),
  {
    projectHeadSha: head,
    worktreeBaseSha: staleHead,
    worktreeWipOid: dirtyWip,
    projectChanged: false,
    worktreeChanged: false,
  },
  "dirty work remains based on its original branch SHA",
);
