export interface AppV2ProjectionSnapshot {
  projectHeadSha: string;
  worktreeBaseSha: string;
  worktreeWipOid: string;
  actualHeadSha: string;
  actualWipOid: string;
}

export interface AppV2ProjectionRepair {
  projectHeadSha: string;
  worktreeBaseSha: string;
  worktreeWipOid: string;
  projectChanged: boolean;
  worktreeChanged: boolean;
}

export function deriveAppV2ProjectionRepair(
  snapshot: AppV2ProjectionSnapshot,
): AppV2ProjectionRepair {
  const worktreeAtHead = snapshot.actualWipOid === snapshot.actualHeadSha;
  const worktreeBaseSha = worktreeAtHead
    ? snapshot.actualHeadSha
    : snapshot.worktreeBaseSha;
  return {
    projectHeadSha: snapshot.actualHeadSha,
    worktreeBaseSha,
    worktreeWipOid: snapshot.actualWipOid,
    projectChanged: snapshot.projectHeadSha !== snapshot.actualHeadSha,
    worktreeChanged:
      snapshot.worktreeWipOid !== snapshot.actualWipOid ||
      snapshot.worktreeBaseSha !== worktreeBaseSha,
  };
}
