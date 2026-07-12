import { randomUUID } from "node:crypto";
import mongoose from "mongoose";
import {
  AppV2ChatRemote,
  AppV2Project,
  AppV2Worktree,
  GitHubInstallation,
  type IAppV2ChatRemote,
  type IAppV2Project,
} from "../database/workspace-schema";
import { getInstallationToken } from "../integrations/github/app-auth";
import {
  GitHubApiError,
  createBlob,
  createBranch,
  getBranchHeadSha,
  getRefCommit,
  getRepoInfo,
  getRepoTree,
  prepareCommit,
  updateBranchRef,
  type GitTreeEntry,
  type TreeChange,
} from "../integrations/github/github-api";
import { publishRealtimeEvent } from "../services/realtime.service";
import { canManageSharing } from "../utils/resource-acl";
import type { AppV2Actor } from "./app-project.service";
import {
  AppV2ConflictError,
  AppV2NotFoundError,
  AppV2ValidationError,
} from "./errors";
import {
  appV2ConversationBranch,
  appV2GitHubConversationBranch,
} from "./conversation-branch";
import { isAppsV2GitHubPushEnabled } from "./config";
import {
  normalizeGitHubSubdirectory,
  validateGitHubOwner,
  validateGitHubRef,
  validateGitHubRepository,
} from "./github-validation";
import { getAppV2Services } from "./service-factory";

const RETRY_DELAYS_MS = [100, 300] as const;
const PUSH_LEASE_MS = 5 * 60_000;

export interface AppV2GitHubClient {
  getRepoInfo: typeof getRepoInfo;
  getBranchHeadSha: typeof getBranchHeadSha;
  getRefCommit: typeof getRefCommit;
  getRepoTree: typeof getRepoTree;
  createBlob: typeof createBlob;
  createBranch: typeof createBranch;
  prepareCommit: typeof prepareCommit;
  updateBranchRef: typeof updateBranchRef;
}

const defaultClient: AppV2GitHubClient = {
  getRepoInfo,
  getBranchHeadSha,
  getRefCommit,
  getRepoTree,
  createBlob,
  createBranch,
  prepareCommit,
  updateBranchRef,
};

export interface AppV2GitHubBindingInput {
  installationId: number;
  owner: string;
  repo: string;
  baseBranch: string;
  subdirectory?: string;
  autoPushOnTurnEnd: boolean;
}

export interface AppV2GitHubPushResult {
  status: "local_only" | "pushed" | "remote_failed" | "conflict";
  remoteBranch?: string;
  remoteSha?: string;
  localSha?: string;
  wipOid?: string;
  error?: string;
  skipped?: boolean;
}

function repoTreePath(
  subdirectory: string | undefined,
  filePath: string,
): string {
  return subdirectory ? `${subdirectory}/${filePath}` : filePath;
}

function isTransient(error: unknown): boolean {
  return (
    error instanceof GitHubApiError &&
    (error.status === 429 || error.status >= 500)
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "GitHub push failed";
}

function canManageGitHubBinding(
  project: IAppV2Project,
  actor: AppV2Actor,
): boolean {
  return (
    (actor.memberRole === "owner" || actor.memberRole === "admin") &&
    canManageSharing(project, actor.userId, actor.memberRole)
  );
}

export function appV2GitHubBindingFingerprint(
  binding: Pick<
    AppV2GitHubBindingInput,
    "installationId" | "owner" | "repo" | "baseBranch" | "subdirectory"
  >,
): string {
  return [
    "v1",
    String(binding.installationId),
    binding.owner.toLowerCase(),
    binding.repo.toLowerCase(),
    binding.baseBranch,
    binding.subdirectory ?? "",
  ].join("\n");
}

function availableLease(now: Date): Record<string, unknown> {
  return {
    $or: [
      { githubPushLease: { $exists: false } },
      { "githubPushLease.expiresAt": { $lte: now } },
    ],
  };
}

export class AppV2GitHubPushService {
  constructor(
    private readonly client: AppV2GitHubClient = defaultClient,
    private readonly tokenForInstallation: (
      installationId: number,
    ) => Promise<string> = getInstallationToken,
    private readonly wait: (delayMs: number) => Promise<void> = delayMs =>
      new Promise(resolve => setTimeout(resolve, delayMs)),
    private readonly createOperationId: () => string = randomUUID,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async bind(
    workspaceId: string,
    projectId: string,
    actor: AppV2Actor,
    input: AppV2GitHubBindingInput,
  ): Promise<IAppV2Project> {
    if (!isAppsV2GitHubPushEnabled()) {
      throw new AppV2NotFoundError("Apps v2 GitHub push is unavailable");
    }
    const project = await getAppV2Services().projects.getReadable(
      workspaceId,
      projectId,
      actor,
    );
    if (!canManageGitHubBinding(project, actor)) {
      throw new AppV2NotFoundError("Project not found");
    }
    if (
      !Number.isSafeInteger(input.installationId) ||
      input.installationId <= 0
    ) {
      throw new AppV2ValidationError("Invalid GitHub installation");
    }
    const installation = await GitHubInstallation.findOne({
      workspaceId: project.workspaceId,
      installationId: input.installationId,
    });
    if (!installation) {
      throw new AppV2NotFoundError("GitHub installation not found");
    }
    const owner = validateGitHubOwner(input.owner);
    const repo = validateGitHubRepository(input.repo);
    const baseBranch = validateGitHubRef(input.baseBranch);
    const subdirectory = normalizeGitHubSubdirectory(input.subdirectory);
    const token = await this.tokenForInstallation(input.installationId);
    const [repoInfo, baseBranchHeadSha] = await Promise.all([
      this.retry(() => this.client.getRepoInfo(owner, repo, token)),
      this.retry(() =>
        this.client.getBranchHeadSha(owner, repo, baseBranch, token),
      ),
    ]);
    if (
      repoInfo.owner.toLowerCase() !== owner.toLowerCase() ||
      repoInfo.name.toLowerCase() !== repo.toLowerCase()
    ) {
      throw new AppV2ValidationError("GitHub repository did not match");
    }
    if (subdirectory) {
      const tree = await this.retry(() =>
        this.client.getRepoTree(owner, repo, baseBranchHeadSha, token),
      );
      if (
        tree.truncated ||
        !tree.entries.some(
          entry =>
            entry.path === subdirectory ||
            entry.path.startsWith(`${subdirectory}/`),
        )
      ) {
        throw new AppV2ValidationError("GitHub subdirectory was not found");
      }
    }
    const github = {
      installationId: input.installationId,
      owner: repoInfo.owner,
      repo: repoInfo.name,
      baseBranch,
      subdirectory,
      bindingFingerprint: appV2GitHubBindingFingerprint({
        installationId: input.installationId,
        owner: repoInfo.owner,
        repo: repoInfo.name,
        baseBranch,
        subdirectory,
      }),
      autoPushOnTurnEnd: input.autoPushOnTurnEnd,
      boundAt: this.now(),
      boundBy: actor.userId,
      baseBranchHeadSha,
      baseBranchUpdatedAt: this.now(),
    };
    const generation = project.githubBindingGeneration ?? 0;
    const session = await mongoose.startSession();
    let updated: IAppV2Project | null = null;
    try {
      await session.withTransaction(async () => {
        updated = await AppV2Project.findOneAndUpdate(
          {
            _id: project._id,
            workspaceId: project.workspaceId,
            deletionStatus: "active",
            githubBindingGeneration: generation,
            ...availableLease(this.now()),
          },
          {
            $set: { github },
            $inc: { mutationRevision: 1, githubBindingGeneration: 1 },
            $unset: { githubPushLease: 1 },
          },
          { new: true, session },
        );
        if (!updated) {
          throw new AppV2ConflictError(
            "Project GitHub binding changed or a push is in progress",
          );
        }
        await AppV2ChatRemote.deleteMany(
          { projectId: project._id },
          { session },
        );
      });
    } finally {
      await session.endSession();
    }
    if (!updated) {
      throw new AppV2ConflictError(
        "Project GitHub binding changed or a push is in progress",
      );
    }
    return updated;
  }

  async unbind(
    workspaceId: string,
    projectId: string,
    actor: AppV2Actor,
  ): Promise<IAppV2Project> {
    if (!isAppsV2GitHubPushEnabled()) {
      throw new AppV2NotFoundError("Apps v2 GitHub push is unavailable");
    }
    const project = await getAppV2Services().projects.getReadable(
      workspaceId,
      projectId,
      actor,
    );
    if (!canManageGitHubBinding(project, actor)) {
      throw new AppV2NotFoundError("Project not found");
    }
    const generation = project.githubBindingGeneration ?? 0;
    const session = await mongoose.startSession();
    let updated: IAppV2Project | null = null;
    try {
      await session.withTransaction(async () => {
        updated = await AppV2Project.findOneAndUpdate(
          {
            _id: project._id,
            workspaceId: project.workspaceId,
            deletionStatus: "active",
            githubBindingGeneration: generation,
            ...availableLease(this.now()),
          },
          {
            $unset: { github: 1, githubPushLease: 1 },
            $inc: { mutationRevision: 1, githubBindingGeneration: 1 },
          },
          { new: true, session },
        );
        if (!updated) {
          throw new AppV2ConflictError(
            "Project GitHub binding changed or a push is in progress",
          );
        }
        await AppV2ChatRemote.deleteMany(
          { projectId: project._id },
          { session },
        );
      });
    } finally {
      await session.endSession();
    }
    if (!updated) {
      throw new AppV2ConflictError(
        "Project GitHub binding changed or a push is in progress",
      );
    }
    return updated;
  }

  async pushConversation(params: {
    workspaceId: string;
    projectId: string;
    chatId: string;
    actor: AppV2Actor;
    localSha: string;
    wipOid?: string;
    requireAutoPush?: boolean;
  }): Promise<AppV2GitHubPushResult> {
    if (!isAppsV2GitHubPushEnabled()) {
      return { status: "local_only", skipped: true };
    }
    const project = await getAppV2Services().projects.getWritable(
      params.workspaceId,
      params.projectId,
      params.actor,
    );
    const binding = project.github;
    if (!binding || (params.requireAutoPush && !binding.autoPushOnTurnEnd)) {
      return { status: "local_only", skipped: true };
    }
    const worktree = await AppV2Worktree.findOne({
      workspaceId: project.workspaceId,
      projectId: project._id,
      actorId: params.actor.userId,
      kind: "agent",
      chatId: params.chatId,
      branch: appV2ConversationBranch(params.chatId),
    });
    if (!worktree?.lastAgentCommitSha) {
      throw new AppV2ConflictError(
        "Conversation branch has no committed local state",
      );
    }

    const localSha = worktree.lastAgentCommitSha;
    const wipOid = worktree.wipOid;
    const remoteBranch = appV2GitHubConversationBranch(
      project._id.toString(),
      params.chatId,
    );
    const bindingGeneration = project.githubBindingGeneration ?? 0;
    const bindingFingerprint =
      binding.bindingFingerprint ??
      appV2GitHubBindingFingerprint({
        installationId: binding.installationId,
        owner: binding.owner,
        repo: binding.repo,
        baseBranch: binding.baseBranch,
        subdirectory: binding.subdirectory,
      });
    const operationId = this.createOperationId();
    const leasedProject = await this.acquireProjectLease(
      project,
      binding,
      bindingGeneration,
      operationId,
    );
    if (!leasedProject) {
      throw new AppV2ConflictError(
        "GitHub binding changed or another push is in progress",
      );
    }

    let operation: { remote: IAppV2ChatRemote; generation: number } | undefined;
    try {
      const installation = await GitHubInstallation.findOne({
        workspaceId: project.workspaceId,
        installationId: binding.installationId,
      });
      await AppV2ChatRemote.updateOne(
        { projectId: project._id, chatId: params.chatId },
        {
          $setOnInsert: {
            workspaceId: project.workspaceId,
            projectId: project._id,
            chatId: params.chatId,
            actorId: params.actor.userId,
            remoteBranch,
            pushStatus: "failed",
            generation: 0,
            bindingGeneration,
            bindingFingerprint,
            observedRemoteShas: [],
          },
        },
        { upsert: true, setDefaultsOnInsert: true },
      );
      let remote = await AppV2ChatRemote.findOne({
        projectId: project._id,
        chatId: params.chatId,
      });
      if (!remote) throw new Error("Failed to initialize GitHub remote state");
      if (
        remote.bindingGeneration !== bindingGeneration ||
        remote.bindingFingerprint !== bindingFingerprint
      ) {
        remote = await AppV2ChatRemote.findOneAndUpdate(
          {
            _id: remote._id,
            generation: remote.generation,
            $or: [
              { operationExpiresAt: { $exists: false } },
              { operationExpiresAt: { $lte: this.now() } },
            ],
          },
          {
            $set: {
              workspaceId: project.workspaceId,
              actorId: params.actor.userId,
              remoteBranch,
              bindingGeneration,
              bindingFingerprint,
              pushStatus: "failed",
              observedRemoteShas: [],
            },
            $inc: { generation: 1 },
            $unset: {
              lastPushedLocalSha: 1,
              lastPushedWipOid: 1,
              lastPushedRemoteSha: 1,
              pushError: 1,
              lastPushAt: 1,
              operationId: 1,
              operationExpiresAt: 1,
              operationBindingGeneration: 1,
              expectedRemoteSha: 1,
              intendedRemoteSha: 1,
              intendedRemoteParentSha: 1,
              targetLocalSha: 1,
              targetWipOid: 1,
              lastSupersededLocalSha: 1,
              lastSupersededAt: 1,
            },
          },
          { new: true },
        );
        if (!remote) {
          throw new AppV2ConflictError(
            "Another GitHub push owns the previous repository binding",
          );
        }
      }
      if (
        remote.pushStatus === "pushed" &&
        remote.bindingGeneration === bindingGeneration &&
        remote.bindingFingerprint === bindingFingerprint &&
        remote.lastPushedLocalSha === localSha
      ) {
        return {
          status: "pushed",
          remoteBranch,
          remoteSha: remote.lastPushedRemoteSha,
          localSha,
          wipOid,
          skipped: true,
        };
      }
      if (remote.pushStatus === "conflict") {
        return {
          status: "conflict",
          remoteBranch,
          localSha,
          wipOid,
          error: remote.pushError ?? "GitHub conversation branch is conflicted",
        };
      }

      const previousTarget = remote.targetLocalSha;
      const reuseIntendedCommit =
        previousTarget === localSha &&
        Boolean(remote.intendedRemoteSha && remote.intendedRemoteParentSha);
      const supersededLocalSha =
        previousTarget && previousTarget !== localSha
          ? previousTarget
          : params.localSha !== localSha
            ? params.localSha
            : undefined;
      const generation = remote.generation ?? 0;
      remote = await AppV2ChatRemote.findOneAndUpdate(
        {
          _id: remote._id,
          generation,
          $or: [
            { operationExpiresAt: { $exists: false } },
            { operationExpiresAt: { $lte: this.now() } },
          ],
        },
        {
          $set: {
            workspaceId: project.workspaceId,
            actorId: params.actor.userId,
            remoteBranch,
            pushStatus: "pending",
            operationId,
            operationExpiresAt: this.leaseExpiry(),
            operationBindingGeneration: bindingGeneration,
            bindingGeneration,
            bindingFingerprint,
            expectedRemoteSha:
              remote.lastPushedRemoteSha ?? remote.expectedRemoteSha,
            targetLocalSha: localSha,
            targetWipOid: wipOid,
            observedRemoteShas: [],
            ...(supersededLocalSha
              ? {
                  lastSupersededLocalSha: supersededLocalSha,
                  lastSupersededAt: this.now(),
                }
              : {}),
          },
          $inc: { generation: 1 },
          $unset: {
            pushError: 1,
            ...(!reuseIntendedCommit
              ? { intendedRemoteSha: 1, intendedRemoteParentSha: 1 }
              : {}),
          },
        },
        { new: true },
      );
      if (!remote) {
        throw new AppV2ConflictError(
          "Another GitHub push already owns this conversation branch",
        );
      }
      operation = { remote, generation: remote.generation };

      if (!installation) {
        return this.transitionFailure(
          operation,
          "GitHub installation not found",
          remoteBranch,
          localSha,
          wipOid,
        );
      }
      const token = await this.tokenForInstallation(binding.installationId);
      if (
        reuseIntendedCommit &&
        remote.intendedRemoteSha &&
        remote.intendedRemoteParentSha
      ) {
        return this.resumeIntendedRemoteUpdate(
          operation,
          project,
          binding,
          bindingGeneration,
          operationId,
          remoteBranch,
          localSha,
          wipOid,
          token,
        );
      }
      const current = await this.resolveRemoteHead(
        project,
        binding,
        bindingGeneration,
        operationId,
        remote,
        remoteBranch,
        token,
      );
      if (current.conflict) {
        return this.transitionConflict(
          operation,
          current.message,
          remoteBranch,
          localSha,
          wipOid,
        );
      }
      await this.updateExpectedRemoteSha(operation, current.commitSha);

      const localEntries = await getAppV2Services().projects.git.tree(
        project.repositoryId,
        localSha,
      );
      const remoteTree = await this.retry(() =>
        this.client.getRepoTree(
          binding.owner,
          binding.repo,
          current.treeSha,
          token,
        ),
      );
      if (remoteTree.truncated) {
        return this.transitionFailure(
          operation,
          "GitHub repository tree is truncated",
          remoteBranch,
          localSha,
          wipOid,
        );
      }
      const localPaths = new Set(
        localEntries.map(entry =>
          repoTreePath(binding.subdirectory, entry.path),
        ),
      );
      const deletions = this.remoteSubdirectoryFiles(
        remoteTree.entries,
        binding.subdirectory,
      )
        .filter(path => !localPaths.has(path))
        .map<TreeChange>(path => ({ path, sha: null }));
      const upserts = await Promise.all(
        localEntries.map(async entry => {
          const file = await getAppV2Services().projects.git.readFile(
            project.repositoryId,
            localSha,
            entry.path,
          );
          const sha = await this.retry(() =>
            this.client.createBlob(
              binding.owner,
              binding.repo,
              file.content.toString("base64"),
              token,
            ),
          );
          return {
            path: repoTreePath(binding.subdirectory, entry.path),
            sha,
            mode: entry.mode === "executable" ? "100755" : "100644",
          } satisfies TreeChange;
        }),
      );

      await this.revalidateProjectLease(
        project,
        binding,
        bindingGeneration,
        operationId,
      );
      const remoteSha = await this.retry(() =>
        this.client.prepareCommit(
          binding.owner,
          binding.repo,
          {
            parentSha: current.commitSha,
            baseTreeSha: current.treeSha,
            message: `Mirror Mako Apps v2 ${localSha.slice(0, 12)}`,
            changes: [...upserts, ...deletions],
          },
          token,
        ),
      );
      await this.persistIntendedRemoteCommit(
        operation,
        current.commitSha,
        remoteSha,
      );
      return this.updatePreparedRemoteRef(
        operation,
        project,
        binding,
        bindingGeneration,
        operationId,
        remoteBranch,
        localSha,
        wipOid,
        token,
      );
    } catch (error) {
      if (!operation) throw error;
      if (error instanceof GitHubApiError && error.status === 422) {
        return this.transitionConflict(
          operation,
          "GitHub branch advanced during push",
          remoteBranch,
          localSha,
          wipOid,
        );
      }
      return this.transitionFailure(
        operation,
        errorMessage(error),
        remoteBranch,
        localSha,
        wipOid,
      );
    } finally {
      if (operation) {
        await AppV2ChatRemote.updateOne(
          {
            _id: operation.remote._id,
            generation: operation.generation,
            operationId,
            bindingGeneration: operation.remote.bindingGeneration,
            bindingFingerprint: operation.remote.bindingFingerprint,
            pushStatus: "pending",
          },
          { $unset: { operationExpiresAt: 1 } },
        );
      }
      await AppV2Project.updateOne(
        {
          _id: project._id,
          "githubPushLease.operationId": operationId,
          "githubPushLease.bindingGeneration": bindingGeneration,
        },
        { $unset: { githubPushLease: 1 } },
      );
    }
  }

  private async acquireProjectLease(
    project: IAppV2Project,
    binding: NonNullable<IAppV2Project["github"]>,
    bindingGeneration: number,
    operationId: string,
  ): Promise<IAppV2Project | null> {
    return AppV2Project.findOneAndUpdate(
      {
        _id: project._id,
        workspaceId: project.workspaceId,
        deletionStatus: "active",
        githubBindingGeneration: bindingGeneration,
        "github.installationId": binding.installationId,
        "github.owner": binding.owner,
        "github.repo": binding.repo,
        "github.baseBranch": binding.baseBranch,
        "github.bindingFingerprint":
          binding.bindingFingerprint ?? appV2GitHubBindingFingerprint(binding),
        ...availableLease(this.now()),
      },
      {
        $set: {
          githubPushLease: {
            operationId,
            bindingGeneration,
            expiresAt: this.leaseExpiry(),
          },
        },
      },
      { new: true },
    );
  }

  private async revalidateProjectLease(
    project: IAppV2Project,
    binding: NonNullable<IAppV2Project["github"]>,
    bindingGeneration: number,
    operationId: string,
  ): Promise<void> {
    const result = await AppV2Project.updateOne(
      {
        _id: project._id,
        githubBindingGeneration: bindingGeneration,
        "github.installationId": binding.installationId,
        "github.owner": binding.owner,
        "github.repo": binding.repo,
        "github.baseBranch": binding.baseBranch,
        "github.bindingFingerprint":
          binding.bindingFingerprint ?? appV2GitHubBindingFingerprint(binding),
        "githubPushLease.operationId": operationId,
        "githubPushLease.bindingGeneration": bindingGeneration,
      },
      { $set: { "githubPushLease.expiresAt": this.leaseExpiry() } },
    );
    if (result.matchedCount !== 1) {
      throw new AppV2ConflictError(
        "GitHub binding changed before the remote update",
      );
    }
  }

  private async resolveRemoteHead(
    project: IAppV2Project,
    binding: NonNullable<IAppV2Project["github"]>,
    bindingGeneration: number,
    operationId: string,
    remote: IAppV2ChatRemote,
    remoteBranch: string,
    token: string,
  ): Promise<
    | { commitSha: string; treeSha: string; conflict: false }
    | { conflict: true; message: string }
  > {
    try {
      const head = await this.retry(() =>
        this.client.getRefCommit(
          binding.owner,
          binding.repo,
          remoteBranch,
          token,
        ),
      );
      if (
        (!remote.lastPushedRemoteSha && !remote.expectedRemoteSha) ||
        head.commitSha !==
          (remote.lastPushedRemoteSha ?? remote.expectedRemoteSha)
      ) {
        return {
          conflict: true,
          message: "GitHub conversation branch advanced externally",
        };
      }
      return { ...head, conflict: false };
    } catch (error) {
      if (!(error instanceof GitHubApiError) || error.status !== 404) {
        throw error;
      }
      const baseSha = await this.retry(() =>
        this.client.getBranchHeadSha(
          binding.owner,
          binding.repo,
          binding.baseBranch,
          token,
        ),
      );
      await this.revalidateProjectLease(
        project,
        binding,
        bindingGeneration,
        operationId,
      );
      try {
        await this.retry(() =>
          this.client.createBranch(
            binding.owner,
            binding.repo,
            remoteBranch,
            baseSha,
            token,
          ),
        );
      } catch (createError) {
        if (
          !(createError instanceof GitHubApiError) ||
          createError.status !== 422
        ) {
          throw createError;
        }
      }
      const head = await this.retry(() =>
        this.client.getRefCommit(
          binding.owner,
          binding.repo,
          remoteBranch,
          token,
        ),
      );
      if (head.commitSha !== baseSha) {
        return {
          conflict: true,
          message: "GitHub conversation branch was created concurrently",
        };
      }
      return { ...head, conflict: false };
    }
  }

  private async updateExpectedRemoteSha(
    operation: { remote: IAppV2ChatRemote; generation: number },
    expectedRemoteSha: string,
  ): Promise<void> {
    const result = await AppV2ChatRemote.updateOne(
      this.operationQuery(operation),
      {
        $set: {
          expectedRemoteSha,
          operationExpiresAt: this.leaseExpiry(),
        },
      },
    );
    if (result.matchedCount !== 1) {
      throw new AppV2ConflictError(
        "GitHub push operation changed concurrently",
      );
    }
    operation.remote.expectedRemoteSha = expectedRemoteSha;
  }

  private async persistIntendedRemoteCommit(
    operation: { remote: IAppV2ChatRemote; generation: number },
    parentSha: string,
    intendedRemoteSha: string,
  ): Promise<void> {
    const result = await AppV2ChatRemote.updateOne(
      this.operationQuery(operation),
      {
        $set: {
          intendedRemoteSha,
          intendedRemoteParentSha: parentSha,
          bindingGeneration: operation.remote.bindingGeneration,
          bindingFingerprint: operation.remote.bindingFingerprint,
          operationExpiresAt: this.leaseExpiry(),
        },
      },
    );
    if (result.matchedCount !== 1) {
      throw new AppV2ConflictError(
        "GitHub push changed before its prepared commit was persisted",
      );
    }
    operation.remote.intendedRemoteSha = intendedRemoteSha;
    operation.remote.intendedRemoteParentSha = parentSha;
  }

  private async resumeIntendedRemoteUpdate(
    operation: { remote: IAppV2ChatRemote; generation: number },
    project: IAppV2Project,
    binding: NonNullable<IAppV2Project["github"]>,
    bindingGeneration: number,
    operationId: string,
    remoteBranch: string,
    localSha: string,
    wipOid: string,
    token: string,
  ): Promise<AppV2GitHubPushResult> {
    const intendedRemoteSha = operation.remote.intendedRemoteSha;
    const parentSha = operation.remote.intendedRemoteParentSha;
    if (!intendedRemoteSha || !parentSha) {
      throw new AppV2ConflictError(
        "Prepared GitHub commit metadata is missing",
      );
    }
    const head = await this.retry(() =>
      this.client.getRefCommit(
        binding.owner,
        binding.repo,
        remoteBranch,
        token,
      ),
    );
    if (head.commitSha === intendedRemoteSha) {
      return this.transitionSuccess(
        operation,
        parentSha,
        intendedRemoteSha,
        remoteBranch,
        localSha,
        wipOid,
      );
    }
    if (head.commitSha !== parentSha) {
      return this.transitionConflict(
        operation,
        "GitHub conversation branch advanced after commit preparation",
        remoteBranch,
        localSha,
        wipOid,
      );
    }
    return this.updatePreparedRemoteRef(
      operation,
      project,
      binding,
      bindingGeneration,
      operationId,
      remoteBranch,
      localSha,
      wipOid,
      token,
    );
  }

  private async updatePreparedRemoteRef(
    operation: { remote: IAppV2ChatRemote; generation: number },
    project: IAppV2Project,
    binding: NonNullable<IAppV2Project["github"]>,
    bindingGeneration: number,
    operationId: string,
    remoteBranch: string,
    localSha: string,
    wipOid: string,
    token: string,
  ): Promise<AppV2GitHubPushResult> {
    const intendedRemoteSha = operation.remote.intendedRemoteSha;
    const parentSha = operation.remote.intendedRemoteParentSha;
    if (!intendedRemoteSha || !parentSha) {
      throw new AppV2ConflictError(
        "Prepared GitHub commit metadata is missing",
      );
    }
    await this.revalidateProjectLease(
      project,
      binding,
      bindingGeneration,
      operationId,
    );
    try {
      await this.retry(() =>
        this.client.updateBranchRef(
          binding.owner,
          binding.repo,
          remoteBranch,
          intendedRemoteSha,
          token,
        ),
      );
    } catch (error) {
      let head: { commitSha: string; treeSha: string };
      try {
        head = await this.retry(() =>
          this.client.getRefCommit(
            binding.owner,
            binding.repo,
            remoteBranch,
            token,
          ),
        );
      } catch (readError) {
        return this.transitionFailure(
          operation,
          `${errorMessage(error)}; branch reconciliation failed: ${errorMessage(readError)}`,
          remoteBranch,
          localSha,
          wipOid,
        );
      }
      if (head.commitSha === intendedRemoteSha) {
        return this.transitionSuccess(
          operation,
          parentSha,
          intendedRemoteSha,
          remoteBranch,
          localSha,
          wipOid,
        );
      }
      if (head.commitSha === parentSha) {
        return this.transitionFailure(
          operation,
          errorMessage(error),
          remoteBranch,
          localSha,
          wipOid,
        );
      }
      return this.transitionConflict(
        operation,
        "GitHub conversation branch advanced during ref update",
        remoteBranch,
        localSha,
        wipOid,
      );
    }
    return this.transitionSuccess(
      operation,
      parentSha,
      intendedRemoteSha,
      remoteBranch,
      localSha,
      wipOid,
    );
  }

  private async transitionSuccess(
    operation: { remote: IAppV2ChatRemote; generation: number },
    expectedRemoteSha: string,
    remoteSha: string,
    remoteBranch: string,
    localSha: string,
    wipOid: string,
  ): Promise<AppV2GitHubPushResult> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const current = await AppV2ChatRemote.findOne(
        this.operationQuery(operation),
      );
      if (!current) {
        const completed = await AppV2ChatRemote.findById(operation.remote._id);
        if (
          completed?.pushStatus === "pushed" &&
          completed.lastPushedLocalSha === localSha &&
          completed.lastPushedRemoteSha === remoteSha
        ) {
          return {
            status: "pushed",
            remoteBranch,
            remoteSha,
            localSha,
            wipOid,
            skipped: true,
          };
        }
        throw new AppV2ConflictError(
          "GitHub push completion changed concurrently",
        );
      }
      const observed = current.observedRemoteShas ?? [];
      const unexpected = observed.find(
        sha => sha !== expectedRemoteSha && sha !== remoteSha,
      );
      if (unexpected) {
        return this.transitionConflict(
          operation,
          "GitHub conversation branch advanced externally during push",
          remoteBranch,
          localSha,
          wipOid,
          observed,
        );
      }
      const result = await AppV2ChatRemote.updateOne(
        { ...this.operationQuery(operation), observedRemoteShas: observed },
        {
          $set: {
            lastPushedLocalSha: localSha,
            lastPushedWipOid: wipOid,
            lastPushedRemoteSha: remoteSha,
            pushStatus: "pushed",
            lastPushAt: this.now(),
            bindingGeneration: operation.remote.bindingGeneration,
            bindingFingerprint: operation.remote.bindingFingerprint,
          },
          $unset: {
            pushError: 1,
            operationExpiresAt: 1,
            targetLocalSha: 1,
            targetWipOid: 1,
            intendedRemoteSha: 1,
            intendedRemoteParentSha: 1,
          },
        },
      );
      if (result.matchedCount === 1) {
        return {
          status: "pushed",
          remoteBranch,
          remoteSha,
          localSha,
          wipOid,
        };
      }
    }
    throw new AppV2ConflictError(
      "GitHub webhook observations did not stabilize",
    );
  }

  private async transitionFailure(
    operation: { remote: IAppV2ChatRemote; generation: number },
    message: string,
    remoteBranch: string,
    localSha: string,
    wipOid: string,
  ): Promise<AppV2GitHubPushResult> {
    await this.transition(
      operation,
      "failed",
      { pushError: message, lastPushAt: this.now() },
      { operationExpiresAt: 1 },
    );
    return {
      status: "remote_failed",
      remoteBranch,
      localSha,
      wipOid,
      error: message,
    };
  }

  private async transitionConflict(
    operation: { remote: IAppV2ChatRemote; generation: number },
    message: string,
    remoteBranch: string,
    localSha: string,
    wipOid: string,
    observedRemoteShas?: string[],
  ): Promise<AppV2GitHubPushResult> {
    await this.transition(
      operation,
      "conflict",
      {
        pushError: message,
        lastPushAt: this.now(),
        ...(observedRemoteShas ? { observedRemoteShas } : {}),
      },
      { operationExpiresAt: 1 },
    );
    await AppV2Worktree.updateOne(
      {
        projectId: operation.remote.projectId,
        chatId: operation.remote.chatId,
        kind: "agent",
      },
      { $set: { status: "conflict" } },
    );
    return {
      status: "conflict",
      remoteBranch,
      localSha,
      wipOid,
      error: message,
    };
  }

  private async transition(
    operation: { remote: IAppV2ChatRemote; generation: number },
    status: IAppV2ChatRemote["pushStatus"],
    fields: Record<string, unknown>,
    unset: Record<string, 1>,
  ): Promise<void> {
    const result = await AppV2ChatRemote.updateOne(
      this.operationQuery(operation),
      {
        $set: {
          ...fields,
          pushStatus: status,
          bindingGeneration: operation.remote.bindingGeneration,
          bindingFingerprint: operation.remote.bindingFingerprint,
        },
        $unset: unset,
      },
    );
    if (result.matchedCount !== 1) {
      throw new AppV2ConflictError(
        "GitHub push state changed before its final transition",
      );
    }
  }

  private operationQuery(operation: {
    remote: IAppV2ChatRemote;
    generation: number;
  }): Record<string, unknown> {
    return {
      _id: operation.remote._id,
      generation: operation.generation,
      operationId: operation.remote.operationId,
      operationBindingGeneration: operation.remote.operationBindingGeneration,
      bindingGeneration: operation.remote.bindingGeneration,
      bindingFingerprint: operation.remote.bindingFingerprint,
      pushStatus: "pending",
    };
  }

  private remoteSubdirectoryFiles(
    entries: GitTreeEntry[],
    subdirectory: string | undefined,
  ): string[] {
    const prefix = subdirectory ? `${subdirectory}/` : "";
    return entries
      .filter(entry => entry.type === "blob" && entry.path.startsWith(prefix))
      .map(entry => entry.path);
  }

  private leaseExpiry(): Date {
    return new Date(this.now().getTime() + PUSH_LEASE_MS);
  }

  private async retry<T>(operation: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        if (!isTransient(error) || attempt >= RETRY_DELAYS_MS.length) {
          throw error;
        }
        await this.wait(RETRY_DELAYS_MS[attempt]);
      }
    }
  }
}

export async function handleAppsV2GitHubPushEvent(params: {
  owner: string;
  repo: string;
  branch: string;
  after?: string;
  installationId: number;
}): Promise<{ matched: number; conflicts: number }> {
  if (!isAppsV2GitHubPushEnabled() || !params.installationId) {
    return { matched: 0, conflicts: 0 };
  }
  const projects = await AppV2Project.find({
    "github.owner": params.owner,
    "github.repo": params.repo,
    "github.installationId": params.installationId,
    deletionStatus: "active",
  });
  let matched = 0;
  let conflicts = 0;
  for (const project of projects) {
    if (project.github?.installationId !== params.installationId) continue;
    const bindingGeneration = project.githubBindingGeneration ?? 0;
    const bindingFingerprint =
      project.github.bindingFingerprint ??
      appV2GitHubBindingFingerprint(project.github);
    matched += 1;
    if (project.github.baseBranch === params.branch) {
      await AppV2Project.updateOne(
        {
          _id: project._id,
          githubBindingGeneration: bindingGeneration,
          "github.installationId": params.installationId,
          "github.bindingFingerprint": bindingFingerprint,
        },
        {
          $set: {
            "github.baseBranchHeadSha": params.after,
            "github.baseBranchUpdatedAt": new Date(),
          },
        },
      );
      continue;
    }
    const remote = await AppV2ChatRemote.findOne({
      projectId: project._id,
      remoteBranch: params.branch,
      bindingGeneration,
      bindingFingerprint,
    });
    if (
      !remote ||
      !params.after ||
      remote.lastPushedRemoteSha === params.after
    ) {
      continue;
    }
    if (
      remote.pushStatus === "pending" &&
      remote.operationId &&
      remote.operationBindingGeneration === bindingGeneration &&
      remote.bindingGeneration === bindingGeneration &&
      remote.bindingFingerprint === bindingFingerprint
    ) {
      await AppV2ChatRemote.updateOne(
        {
          _id: remote._id,
          generation: remote.generation,
          operationId: remote.operationId,
          bindingGeneration,
          bindingFingerprint,
          pushStatus: "pending",
        },
        {
          $addToSet: { observedRemoteShas: params.after },
          $set: {
            lastPushAt: new Date(),
            bindingGeneration,
            bindingFingerprint,
          },
        },
      );
      continue;
    }

    const message = "GitHub conversation branch advanced externally";
    const transitioned = await AppV2ChatRemote.updateOne(
      {
        _id: remote._id,
        generation: remote.generation,
        bindingGeneration,
        bindingFingerprint,
        pushStatus: remote.pushStatus,
      },
      {
        $set: {
          pushStatus: "conflict",
          pushError: message,
          lastPushAt: new Date(),
          bindingGeneration,
          bindingFingerprint,
        },
      },
    );
    if (transitioned.matchedCount !== 1) continue;
    conflicts += 1;
    await AppV2Worktree.updateOne(
      {
        projectId: project._id,
        chatId: remote.chatId,
        actorId: remote.actorId,
      },
      { $set: { status: "conflict" } },
    );
    publishRealtimeEvent(project.workspaceId.toString(), {
      type: "app-v2.github.conflict",
      projectId: project._id.toString(),
      chatId: remote.chatId,
      remoteBranch: remote.remoteBranch,
      forUserId: remote.actorId,
    });
  }
  return { matched, conflicts };
}
