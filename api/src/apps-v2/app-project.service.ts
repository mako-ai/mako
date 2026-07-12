import { Types } from "mongoose";
import { createAppV2Scaffold, type AppV2ProjectCreate } from "@mako/schemas";
import {
  AppV2Commit,
  AppV2Project,
  AppV2Worktree,
  type IAppV2Project,
  type IAppV2Worktree,
} from "../database/workspace-schema";
import { canReadResource, canWriteResource } from "../utils/resource-acl";
import { getAppsV2GitRoot } from "./config";
import {
  AppV2ConflictError,
  AppV2NotFoundError,
  AppV2ValidationError,
} from "./errors";
import {
  AppV2GitProvider,
  type AppV2GitBranch,
  type AppV2GitCommit,
} from "./providers/git-provider";
import { appV2ConversationBranch } from "./conversation-branch";
import {
  AppV2ProjectSessionCleanupService,
  type AppV2ProjectSessionCleanup,
} from "./project-session-cleanup";

export interface AppV2Actor {
  userId: string;
  memberRole?: string;
}

export interface AppV2ConversationBranchMetadata {
  worktree: IAppV2Worktree;
  git: AppV2GitBranch;
  dirty: boolean;
}

export class AppV2ProjectService {
  readonly git: AppV2GitProvider;

  constructor(
    git = new AppV2GitProvider(getAppsV2GitRoot()),
    private readonly sessionCleanup: AppV2ProjectSessionCleanup = new AppV2ProjectSessionCleanupService(),
  ) {
    this.git = git;
  }

  async list(workspaceId: string, actor: AppV2Actor): Promise<IAppV2Project[]> {
    const projects = await AppV2Project.find({
      workspaceId: new Types.ObjectId(workspaceId),
      deletionStatus: "active",
      $or: [
        { owner_id: actor.userId },
        { access: "workspace" },
        { "sharedWith.userId": actor.userId },
      ],
    }).sort({ updatedAt: -1 });
    const readable = projects.filter(project =>
      canReadResource(project, actor.userId, actor.memberRole),
    );
    return Promise.all(
      readable.map(project => this.repairProjectProjection(project)),
    );
  }

  async create(
    workspaceId: string,
    actor: AppV2Actor,
    input: AppV2ProjectCreate,
  ): Promise<IAppV2Project> {
    const projectId = new Types.ObjectId();
    const repositoryId = projectId.toString();
    const initialCommit = await this.git.createRepository(
      repositoryId,
      createAppV2Scaffold(),
    );
    let project: IAppV2Project | undefined;
    try {
      project = await AppV2Project.create({
        _id: projectId,
        workspaceId: new Types.ObjectId(workspaceId),
        title: input.title,
        description: input.description,
        access: input.access,
        workspaceRole: input.workspaceRole,
        sharedWith: [],
        owner_id: actor.userId,
        createdBy: actor.userId,
        repositoryProvider: "mako-git",
        repositoryId,
        defaultBranch: "main",
        headSha: initialCommit.sha,
        mutationRevision: 0,
        deletionStatus: "active",
      });
      await this.recordCommit(project, initialCommit, actor.userId);
      return project;
    } catch (error) {
      if (project) {
        await AppV2Project.deleteOne({
          _id: project._id,
          workspaceId: project.workspaceId,
        });
      }
      await this.git.deleteRepository(repositoryId);
      throw error;
    }
  }

  async getReadable(
    workspaceId: string,
    projectId: string,
    actor: AppV2Actor,
  ): Promise<IAppV2Project> {
    const project = await this.find(workspaceId, projectId);
    if (!canReadResource(project, actor.userId, actor.memberRole)) {
      throw new AppV2NotFoundError("Project not found");
    }
    return project;
  }

  async getWritable(
    workspaceId: string,
    projectId: string,
    actor: AppV2Actor,
  ): Promise<IAppV2Project> {
    const project = await this.find(workspaceId, projectId);
    if (!canWriteResource(project, actor.userId, actor.memberRole)) {
      throw new AppV2NotFoundError("Project not found");
    }
    return project;
  }

  async listConversationBranches(
    project: IAppV2Project,
    actor: AppV2Actor,
  ): Promise<AppV2ConversationBranchMetadata[]> {
    const worktrees = await AppV2Worktree.find({
      workspaceId: project.workspaceId,
      projectId: project._id,
      actorId: actor.userId,
      kind: "agent",
    })
      .sort({ updatedAt: -1 })
      .select(
        "chatId branch baseSha wipOid lastAgentCommitSha status updatedAt",
      );
    const branches = await this.git.listBranches(
      project.repositoryId,
      project.defaultBranch,
    );
    const gitByName = new Map(
      branches
        .filter(branch => !branch.isDefault)
        .map(branch => [branch.name, branch]),
    );
    return worktrees.flatMap(worktree => {
      if (
        !worktree.chatId ||
        worktree.branch !== appV2ConversationBranch(worktree.chatId)
      ) {
        return [];
      }
      const git = gitByName.get(worktree.branch);
      if (!git) return [];
      return [{ worktree, git, dirty: worktree.wipOid !== git.headSha }];
    });
  }

  async mergeConversationBranchToDefault(
    project: IAppV2Project,
    branch: string,
    actor: AppV2Actor,
  ): Promise<{
    project: IAppV2Project;
    branch: string;
    branchHeadSha: string;
    mergedSha: string;
    fastForward: boolean;
  }> {
    const worktree = await AppV2Worktree.findOne({
      workspaceId: project.workspaceId,
      projectId: project._id,
      actorId: actor.userId,
      kind: "agent",
      branch,
    });
    if (
      !worktree?.chatId ||
      worktree.branch !== appV2ConversationBranch(worktree.chatId)
    ) {
      throw new AppV2NotFoundError("Conversation branch not found");
    }
    if (!worktree.lastAgentCommitSha) {
      throw new AppV2ValidationError(
        "Conversation branch has no committed turn to merge",
      );
    }

    const result = await this.git.mergeConversationBranchToDefault(
      project.repositoryId,
      project.defaultBranch,
      branch,
      project.headSha,
      worktree.lastAgentCommitSha,
      {
        name: `Mako user ${actor.userId}`,
        email: `${actor.userId}@users.mako.local`,
      },
    );
    let updated = await AppV2Project.findOneAndUpdate(
      {
        _id: project._id,
        workspaceId: project.workspaceId,
        deletionStatus: "active",
        headSha: result.previousDefaultHeadSha,
      },
      {
        $set: { headSha: result.mergedSha },
        $inc: { mutationRevision: 1 },
      },
      { new: true },
    );
    if (!updated) {
      updated = await AppV2Project.findOne({
        _id: project._id,
        workspaceId: project.workspaceId,
        deletionStatus: "active",
        headSha: result.mergedSha,
      });
    }
    if (!updated) {
      throw new AppV2ConflictError(
        "Project head projection changed concurrently",
      );
    }
    const commit = await this.git.getCommit(
      project.repositoryId,
      result.mergedSha,
    );
    await this.recordCommit(updated, commit, actor.userId);
    return {
      project: updated,
      branch,
      branchHeadSha: result.branchHeadSha,
      mergedSha: result.mergedSha,
      fastForward: result.fastForward,
    };
  }

  async delete(
    workspaceId: string,
    projectId: string,
    actor: AppV2Actor,
  ): Promise<IAppV2Project> {
    let project = await this.findForDeletion(workspaceId, projectId, actor);
    if (project.deletionStatus === "active") {
      const transitioning = await AppV2Project.findOneAndUpdate(
        {
          _id: project._id,
          workspaceId: project.workspaceId,
          deletionStatus: "active",
        },
        {
          $set: {
            deletionStatus: "deleting",
            deletedBy: actor.userId,
          },
          $inc: { mutationRevision: 1 },
        },
        { new: true },
      );
      project =
        transitioning ??
        (await this.findForDeletion(workspaceId, projectId, actor));
    }
    await this.sessionCleanup.revokeAndKill(
      project.workspaceId.toString(),
      project._id.toString(),
    );
    const worktrees = await AppV2Worktree.find({
      workspaceId: project.workspaceId,
      projectId: project._id,
    });
    for (const worktree of worktrees) {
      await this.fenceDeletedWorktree(project, worktree);
    }
    const deleted = await AppV2Project.findOneAndUpdate(
      {
        _id: project._id,
        workspaceId: project.workspaceId,
        deletionStatus: "deleting",
      },
      {
        $set: {
          deletionStatus: "deleted",
          deletedAt: new Date(),
        },
      },
      { new: true },
    );
    if (deleted) return deleted;
    const concurrentlyDeleted = await AppV2Project.findOne({
      _id: project._id,
      workspaceId: project.workspaceId,
      deletionStatus: "deleted",
    });
    if (concurrentlyDeleted) return concurrentlyDeleted;
    throw new AppV2ConflictError("Project deletion state changed concurrently");
  }

  private async findForDeletion(
    workspaceId: string,
    projectId: string,
    actor: AppV2Actor,
  ): Promise<IAppV2Project> {
    if (!Types.ObjectId.isValid(projectId)) {
      throw new AppV2NotFoundError("Project not found");
    }
    const project = await AppV2Project.findOne({
      _id: new Types.ObjectId(projectId),
      workspaceId: new Types.ObjectId(workspaceId),
      deletionStatus: { $in: ["active", "deleting"] },
    });
    if (!project) throw new AppV2NotFoundError("Project not found");
    const authorized =
      canWriteResource(project, actor.userId, actor.memberRole) ||
      (project.deletionStatus === "deleting" &&
        project.deletedBy === actor.userId);
    if (!authorized) throw new AppV2NotFoundError("Project not found");
    return project;
  }

  private async fenceDeletedWorktree(
    project: IAppV2Project,
    worktree: IAppV2Worktree,
  ): Promise<void> {
    let actualLease = await this.git.getLease(
      project.repositoryId,
      worktree.leaseRef,
    );
    let fencedLease:
      | Awaited<ReturnType<AppV2GitProvider["fenceLease"]>>
      | undefined;
    if (actualLease.purpose === "deletion-fence") {
      fencedLease = actualLease;
    }
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (fencedLease) break;
      try {
        fencedLease = await this.git.fenceLease(
          project.repositoryId,
          worktree.leaseRef,
          actualLease.oid,
          actualLease.epoch + 1,
        );
        break;
      } catch (error) {
        if (!(error instanceof AppV2ConflictError) || attempt === 2) {
          throw error;
        }
        actualLease = await this.git.getLease(
          project.repositoryId,
          worktree.leaseRef,
        );
        if (actualLease.purpose === "deletion-fence") {
          fencedLease = actualLease;
        }
      }
    }
    if (!fencedLease) {
      throw new AppV2ConflictError("Failed to fence deleted worktree");
    }
    if (
      worktree.status === "fenced" &&
      worktree.leaseOid === fencedLease.oid &&
      worktree.leaseEpoch === fencedLease.epoch
    ) {
      return;
    }
    const updated = await AppV2Worktree.findOneAndUpdate(
      {
        _id: worktree._id,
        workspaceId: project.workspaceId,
        projectId: project._id,
        leaseEpoch: { $lt: fencedLease.epoch },
      },
      {
        $set: {
          leaseOid: fencedLease.oid,
          leaseEpoch: fencedLease.epoch,
          status: "fenced",
        },
        $inc: { revision: 1 },
      },
      { new: true },
    );
    if (updated) return;
    const current = await AppV2Worktree.findOne({
      _id: worktree._id,
      workspaceId: project.workspaceId,
      projectId: project._id,
    });
    if (
      !current ||
      current.leaseEpoch < fencedLease.epoch ||
      current.leaseOid !== fencedLease.oid
    ) {
      throw new AppV2ConflictError(
        "Deleting worktree fence projection changed concurrently",
      );
    }
  }

  async recordCommit(
    project: IAppV2Project,
    commit: AppV2GitCommit,
    actorId: string,
  ): Promise<void> {
    await AppV2Commit.updateOne(
      {
        workspaceId: project.workspaceId,
        projectId: project._id,
        sha: commit.sha,
      },
      {
        $setOnInsert: {
          workspaceId: project.workspaceId,
          projectId: project._id,
          sha: commit.sha,
          treeSha: commit.treeSha,
          parentShas: commit.parentShas,
          message: commit.message,
          authorName: commit.authorName,
          authorEmail: commit.authorEmail,
          authoredAt: commit.authoredAt,
          stats: commit.stats,
          createdBy: actorId,
        },
      },
      { upsert: true },
    );
  }

  async repairProjectProjection(
    initialProject: IAppV2Project,
  ): Promise<IAppV2Project> {
    let project = initialProject;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const actualHeadSha = await this.git.resolveRef(
        project.repositoryId,
        `refs/heads/${project.defaultBranch}`,
      );
      if (project.headSha === actualHeadSha) return project;
      const updated = await AppV2Project.findOneAndUpdate(
        {
          _id: project._id,
          workspaceId: project.workspaceId,
          deletionStatus: "active",
          headSha: project.headSha,
        },
        { $set: { headSha: actualHeadSha } },
        { new: true },
      );
      if (updated) return updated;
      const current = await AppV2Project.findOne({
        _id: project._id,
        workspaceId: project.workspaceId,
        deletionStatus: "active",
      });
      if (!current) throw new AppV2NotFoundError("Project not found");
      project = current;
    }
    throw new AppV2ConflictError("Project head projection is changing");
  }

  private async find(
    workspaceId: string,
    projectId: string,
  ): Promise<IAppV2Project> {
    if (!Types.ObjectId.isValid(projectId)) {
      throw new AppV2NotFoundError("Project not found");
    }
    const project = await AppV2Project.findOne({
      _id: new Types.ObjectId(projectId),
      workspaceId: new Types.ObjectId(workspaceId),
      deletionStatus: "active",
    });
    if (!project) throw new AppV2NotFoundError("Project not found");
    return this.repairProjectProjection(project);
  }
}
