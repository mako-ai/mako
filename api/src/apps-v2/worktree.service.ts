import mongoose, { Types, type FilterQuery, type UpdateQuery } from "mongoose";
import type { AppV2MutationState } from "@mako/schemas";
import {
  AppV2Project,
  AppV2Worktree,
  type IAppV2Project,
  type IAppV2Worktree,
} from "../database/workspace-schema";
import { AppV2ProjectService, type AppV2Actor } from "./app-project.service";
import {
  AppV2ConflictError,
  AppV2NotFoundError,
  AppV2ValidationError,
} from "./errors";
import { deriveAppV2ProjectionRepair } from "./projection-repair";
import type { AppV2ReplacementFile } from "./providers/git-provider";

export class AppV2WorktreeService {
  constructor(private readonly projects = new AppV2ProjectService()) {}

  async getOrCreate(
    project: IAppV2Project,
    actor: AppV2Actor,
  ): Promise<IAppV2Worktree> {
    const existing = await AppV2Worktree.findOne({
      workspaceId: project.workspaceId,
      projectId: project._id,
      actorId: actor.userId,
    });
    if (existing) return this.recoverProjection(project, existing);

    const worktreeId = new Types.ObjectId();
    const privateRef = await this.projects.git.createWorktreeRef(
      project.repositoryId,
      worktreeId.toString(),
      project.headSha,
    );
    // If projection fails, refs are intentionally retained so a reconciler can
    // recover interrupted Mongo state from Git authority.
    const session = await mongoose.startSession();
    let created: IAppV2Worktree | undefined;
    try {
      await session.withTransaction(async () => {
        const activeProject = await AppV2Project.updateOne(
          {
            _id: project._id,
            workspaceId: project.workspaceId,
            deletionStatus: "active",
          },
          { $inc: { mutationRevision: 1 } },
          { session },
        );
        if (activeProject.modifiedCount !== 1) {
          throw new AppV2ConflictError("Project is no longer active");
        }
        [created] = await AppV2Worktree.create(
          [
            {
              _id: worktreeId,
              workspaceId: project.workspaceId,
              projectId: project._id,
              actorId: actor.userId,
              branch: project.defaultBranch,
              baseSha: project.headSha,
              wipRef: privateRef.wipRef,
              wipOid: privateRef.wipOid,
              leaseRef: privateRef.leaseRef,
              leaseOid: privateRef.leaseOid,
              revision: 0,
              leaseEpoch: 1,
              status: "active",
            },
          ],
          { session },
        );
      });
    } finally {
      await session.endSession();
    }
    if (!created) {
      throw new AppV2ConflictError("Worktree projection was not created");
    }
    return created;
  }

  async getActorWorktree(
    project: IAppV2Project,
    actor: AppV2Actor,
  ): Promise<IAppV2Worktree> {
    const worktree = await AppV2Worktree.findOne({
      workspaceId: project.workspaceId,
      projectId: project._id,
      actorId: actor.userId,
    });
    if (!worktree) throw new AppV2NotFoundError("Worktree not found");
    return this.recoverProjection(project, worktree);
  }

  async getById(
    project: IAppV2Project,
    worktreeId: string,
    actor: AppV2Actor,
  ): Promise<IAppV2Worktree> {
    if (!Types.ObjectId.isValid(worktreeId)) {
      throw new AppV2NotFoundError("Worktree not found");
    }
    const worktree = await AppV2Worktree.findOne({
      _id: new Types.ObjectId(worktreeId),
      workspaceId: project.workspaceId,
      projectId: project._id,
      actorId: actor.userId,
    });
    if (!worktree) throw new AppV2NotFoundError("Worktree not found");
    return this.recoverProjection(project, worktree);
  }

  async tree(project: IAppV2Project, worktree: IAppV2Worktree) {
    return this.projects.git.tree(project.repositoryId, worktree.wipOid);
  }

  async read(
    project: IAppV2Project,
    worktree: IAppV2Worktree,
    filePath: string,
  ) {
    const result = await this.projects.git.readFile(
      project.repositoryId,
      worktree.wipOid,
      filePath,
    );
    try {
      return {
        ...result,
        content: new TextDecoder("utf-8", { fatal: true }).decode(
          result.content,
        ),
      };
    } catch {
      throw new AppV2ValidationError("File is not valid UTF-8");
    }
  }

  async status(project: IAppV2Project, worktree: IAppV2Worktree) {
    const changes = await this.projects.git.status(
      project.repositoryId,
      worktree.baseSha,
      worktree.wipOid,
    );
    return { changes, clean: changes.length === 0 };
  }

  async write(
    project: IAppV2Project,
    worktree: IAppV2Worktree,
    state: AppV2MutationState,
    filePath: string,
    content: string,
    executable: boolean,
  ): Promise<IAppV2Worktree> {
    await this.assertMutationState(project, worktree, state);
    const result = await this.projects.git.writeFile(
      project.repositoryId,
      worktree.wipRef,
      state.expectedWipOid,
      worktree.baseSha,
      worktree.leaseRef,
      worktree.leaseOid,
      filePath,
      Buffer.from(content, "utf8"),
      executable,
    );
    return this.persistAdvance(project, worktree, state, result.wipOid);
  }

  async delete(
    project: IAppV2Project,
    worktree: IAppV2Worktree,
    state: AppV2MutationState,
    filePath: string,
  ): Promise<IAppV2Worktree> {
    await this.assertMutationState(project, worktree, state);
    const result = await this.projects.git.deleteFile(
      project.repositoryId,
      worktree.wipRef,
      state.expectedWipOid,
      worktree.baseSha,
      worktree.leaseRef,
      worktree.leaseOid,
      filePath,
    );
    return this.persistAdvance(project, worktree, state, result.wipOid);
  }

  async replaceTree(
    project: IAppV2Project,
    worktree: IAppV2Worktree,
    state: AppV2MutationState,
    files: readonly AppV2ReplacementFile[],
    recoveryId?: string,
  ): Promise<IAppV2Worktree> {
    await this.assertReplacementState(project, worktree, state);
    const result = await this.projects.git.replaceWorktreeTree(
      project.repositoryId,
      worktree.wipRef,
      state.expectedWipOid,
      worktree.baseSha,
      worktree.leaseRef,
      worktree.leaseOid,
      files,
      recoveryId,
    );
    return this.persistAdvance(project, worktree, state, result.wipOid);
  }

  async move(
    project: IAppV2Project,
    worktree: IAppV2Worktree,
    state: AppV2MutationState,
    from: string,
    to: string,
  ): Promise<IAppV2Worktree> {
    await this.assertMutationState(project, worktree, state);
    const result = await this.projects.git.moveFile(
      project.repositoryId,
      worktree.wipRef,
      state.expectedWipOid,
      worktree.baseSha,
      worktree.leaseRef,
      worktree.leaseOid,
      from,
      to,
    );
    return this.persistAdvance(project, worktree, state, result.wipOid);
  }

  async discard(
    project: IAppV2Project,
    worktree: IAppV2Worktree,
    state: AppV2MutationState,
  ): Promise<IAppV2Worktree> {
    await this.assertMutationState(project, worktree, state);
    const branchHeadSha = await this.projects.git.resolveRef(
      project.repositoryId,
      `refs/heads/${worktree.branch}`,
    );
    const result = await this.projects.git.discard(
      project.repositoryId,
      `refs/heads/${worktree.branch}`,
      branchHeadSha,
      worktree.wipRef,
      state.expectedWipOid,
      worktree.leaseRef,
      worktree.leaseOid,
    );
    return this.persistAdvance(
      project,
      worktree,
      state,
      result.wipOid,
      branchHeadSha,
    );
  }

  async commit(
    project: IAppV2Project,
    worktree: IAppV2Worktree,
    state: AppV2MutationState,
    message: string,
    actor: AppV2Actor,
  ): Promise<{ worktree: IAppV2Worktree; sha: string }> {
    await this.assertMutationState(project, worktree, state);
    const commit = await this.projects.git.commit(
      project.repositoryId,
      worktree.branch,
      worktree.wipRef,
      state.expectedWipOid,
      worktree.baseSha,
      worktree.leaseRef,
      worktree.leaseOid,
      message,
    );
    const updated = await this.persistAdvance(
      project,
      worktree,
      state,
      commit.sha,
      commit.sha,
      { expectedHeadSha: worktree.baseSha, headSha: commit.sha },
    );
    await this.projects.recordCommit(project, commit, actor.userId);
    return { worktree: updated, sha: commit.sha };
  }

  async rotateLease(
    project: IAppV2Project,
    worktree: IAppV2Worktree,
    state: AppV2MutationState,
  ): Promise<IAppV2Worktree> {
    await this.assertMutationState(project, worktree, state);
    const lease = await this.projects.git.rotateLease(
      project.repositoryId,
      worktree.wipRef,
      state.expectedWipOid,
      worktree.leaseRef,
      worktree.leaseOid,
      worktree.leaseEpoch + 1,
    );
    return this.persistActiveWorktree(
      project,
      {
        _id: worktree._id,
        workspaceId: project.workspaceId,
        projectId: project._id,
        revision: state.ifRevision,
        wipOid: state.expectedWipOid,
        leaseEpoch: state.leaseEpoch,
        leaseOid: worktree.leaseOid,
      },
      {
        $set: { leaseOid: lease.oid, leaseEpoch: lease.epoch },
        $inc: { revision: 1 },
      },
    );
  }

  async listCommits(project: IAppV2Project, limit: number) {
    const commits = await this.projects.git.listCommits(
      project.repositoryId,
      `refs/heads/${project.defaultBranch}`,
      limit,
    );
    await Promise.all(
      commits.map(commit =>
        this.projects.recordCommit(project, commit, "git-repair"),
      ),
    );
    return commits;
  }

  async getCommit(project: IAppV2Project, sha: string) {
    const isBranchCommit = await this.projects.git.isAncestor(
      project.repositoryId,
      sha,
      `refs/heads/${project.defaultBranch}`,
    );
    if (!isBranchCommit) throw new AppV2NotFoundError("Commit not found");
    const commit = await this.projects.git.getCommit(project.repositoryId, sha);
    await this.projects.recordCommit(project, commit, "git-repair");
    return commit;
  }

  private async assertMutationState(
    project: IAppV2Project,
    worktree: IAppV2Worktree,
    state: AppV2MutationState,
  ): Promise<void> {
    if (
      worktree.revision !== state.ifRevision ||
      worktree.wipOid !== state.expectedWipOid ||
      worktree.leaseEpoch !== state.leaseEpoch
    ) {
      throw new AppV2ConflictError("Stale worktree mutation state");
    }
    const activeProject = await AppV2Project.exists({
      _id: project._id,
      workspaceId: project.workspaceId,
      deletionStatus: "active",
    });
    if (!activeProject) throw new AppV2NotFoundError("Project not found");
    const actualOid = await this.projects.git.resolveRef(
      project.repositoryId,
      worktree.wipRef,
    );
    if (actualOid !== state.expectedWipOid) {
      await this.recoverProjection(project, worktree);
      throw new AppV2ConflictError("Stale worktree Git ref");
    }
    const actualLease = await this.projects.git.getLease(
      project.repositoryId,
      worktree.leaseRef,
    );
    if (
      actualLease.oid !== worktree.leaseOid ||
      actualLease.epoch !== worktree.leaseEpoch
    ) {
      await this.recoverProjection(project, worktree);
      throw new AppV2ConflictError("Stale worktree lease");
    }
  }

  private async assertReplacementState(
    project: IAppV2Project,
    worktree: IAppV2Worktree,
    state: AppV2MutationState,
  ): Promise<void> {
    if (
      worktree.revision !== state.ifRevision ||
      worktree.wipOid !== state.expectedWipOid ||
      worktree.leaseEpoch !== state.leaseEpoch
    ) {
      throw new AppV2ConflictError("Stale worktree mutation state");
    }
    const activeProject = await AppV2Project.exists({
      _id: project._id,
      workspaceId: project.workspaceId,
      deletionStatus: "active",
    });
    if (!activeProject) throw new AppV2NotFoundError("Project not found");
    // replaceWorktreeTree performs the authoritative WIP + lease ref CAS. It
    // must receive stale Git state so it can preserve the captured commit on a
    // private recovery ref rather than dropping the capture at preflight.
  }

  private async persistAdvance(
    project: IAppV2Project,
    worktree: IAppV2Worktree,
    state: AppV2MutationState,
    wipOid: string,
    baseSha?: string,
    projectHead?: { expectedHeadSha: string; headSha: string },
  ): Promise<IAppV2Worktree> {
    return this.persistActiveWorktree(
      project,
      {
        _id: worktree._id,
        workspaceId: project.workspaceId,
        projectId: project._id,
        revision: state.ifRevision,
        wipOid: state.expectedWipOid,
        leaseEpoch: state.leaseEpoch,
        leaseOid: worktree.leaseOid,
      },
      {
        $set: {
          wipOid,
          status: "active",
          ...(baseSha ? { baseSha } : {}),
        },
        $inc: { revision: 1 },
      },
      projectHead,
    );
  }

  private async persistActiveWorktree(
    project: IAppV2Project,
    filter: FilterQuery<IAppV2Worktree>,
    update: UpdateQuery<IAppV2Worktree>,
    projectHead?: { expectedHeadSha: string; headSha: string },
  ): Promise<IAppV2Worktree> {
    const session = await mongoose.startSession();
    let updated: IAppV2Worktree | null = null;
    try {
      await session.withTransaction(async () => {
        const projectResult = await AppV2Project.updateOne(
          {
            _id: project._id,
            workspaceId: project.workspaceId,
            deletionStatus: "active",
            ...(projectHead ? { headSha: projectHead.expectedHeadSha } : {}),
          },
          {
            $inc: { mutationRevision: 1 },
            ...(projectHead ? { $set: { headSha: projectHead.headSha } } : {}),
          },
          { session },
        );
        if (projectResult.modifiedCount !== 1) {
          throw new AppV2ConflictError(
            "Project is no longer active or changed concurrently",
          );
        }
        updated = await AppV2Worktree.findOneAndUpdate(filter, update, {
          new: true,
          session,
        });
        if (!updated) {
          throw new AppV2ConflictError(
            "Worktree metadata changed concurrently",
          );
        }
      });
    } finally {
      await session.endSession();
    }
    if (!updated) {
      throw new AppV2ConflictError("Worktree projection was not persisted");
    }
    return updated;
  }

  private async recoverProjection(
    project: IAppV2Project,
    worktree: IAppV2Worktree,
  ): Promise<IAppV2Worktree> {
    let current = worktree;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const repairedProject =
        await this.projects.repairProjectProjection(project);
      const actualWipOid = await this.projects.git.resolveRef(
        repairedProject.repositoryId,
        current.wipRef,
      );
      const actualLease = await this.projects.git.getLease(
        repairedProject.repositoryId,
        current.leaseRef,
      );
      const repair = deriveAppV2ProjectionRepair({
        projectHeadSha: repairedProject.headSha,
        worktreeBaseSha: current.baseSha,
        worktreeWipOid: current.wipOid,
        actualHeadSha: repairedProject.headSha,
        actualWipOid,
      });
      const leaseChanged =
        current.leaseOid !== actualLease.oid ||
        current.leaseEpoch !== actualLease.epoch;
      if (!repair.worktreeChanged && !leaseChanged) return current;
      const recovered = await AppV2Worktree.findOneAndUpdate(
        {
          _id: current._id,
          workspaceId: repairedProject.workspaceId,
          projectId: repairedProject._id,
          revision: current.revision,
          leaseEpoch: current.leaseEpoch,
          wipOid: current.wipOid,
          baseSha: current.baseSha,
          leaseOid: current.leaseOid,
        },
        {
          $set: {
            wipOid: repair.worktreeWipOid,
            baseSha: repair.worktreeBaseSha,
            leaseOid: actualLease.oid,
            leaseEpoch: actualLease.epoch,
          },
          $inc: { revision: 1 },
        },
        { new: true },
      );
      if (recovered) return recovered;
      const latest = await AppV2Worktree.findOne({
        _id: current._id,
        workspaceId: repairedProject.workspaceId,
        projectId: repairedProject._id,
        actorId: current.actorId,
      });
      if (!latest) throw new AppV2NotFoundError("Worktree not found");
      current = latest;
    }
    throw new AppV2ConflictError("Worktree projection is changing");
  }
}
