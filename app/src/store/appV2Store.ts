import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { ApiError } from "../api/result";
import { apiClient } from "../lib/api-client";

export interface AppV2Project {
  id: string;
  workspaceId: string;
  title: string;
  description?: string;
  access: "private" | "workspace";
  workspaceRole: "viewer" | "editor";
  sharedWith: Array<{ userId: string; role: "viewer" | "editor" }>;
  ownerId: string;
  effectiveRole: "owner" | "editor" | "viewer";
  readOnly: boolean;
  repositoryProvider: string;
  repositoryId: string;
  defaultBranch: string;
  headSha: string;
  githubPushAvailable: boolean;
  githubCanManage: boolean;
  github?: AppV2GitHubBinding;
  createdAt: string;
  updatedAt: string;
}

export interface AppV2GitHubBinding {
  installationId: number;
  owner: string;
  repo: string;
  baseBranch: string;
  subdirectory?: string;
  autoPushOnTurnEnd: boolean;
  generation: number;
  boundAt: string;
  boundBy: string;
}

export interface AppV2GitHubStatus {
  appConfigured: boolean;
  installations: Array<{
    installationId: number;
    accountLogin: string;
    accountType: "Organization" | "User";
  }>;
}

export interface AppV2GitHubRepo {
  owner: string;
  name: string;
  fullName: string;
  defaultBranch: string;
  private: boolean;
}

export interface AppV2Worktree {
  id: string;
  projectId: string;
  actorId: string;
  branch: string;
  baseSha: string;
  wipOid: string;
  revision: number;
  leaseEpoch: number;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface AppV2ConversationBranch {
  chatId: string;
  branch: string;
  baseSha: string;
  wipOid: string;
  lastCommitSha?: string;
  status: string;
  remote?: {
    branch: string;
    status: "pending" | "pushed" | "failed" | "conflict";
    lastPushedLocalSha?: string;
    lastPushedRemoteSha?: string;
    error?: string;
    lastPushAt?: string;
  };
}

export interface AppV2TreeEntry {
  path: string;
  oid: string;
  size: number;
  mode: "regular" | "executable";
}

export interface AppV2File {
  path: string;
  oid: string;
  mode: "regular" | "executable";
  content: string;
}

export interface AppV2EditorBuffer {
  projectId: string;
  path: string;
  content: string;
  dirty: boolean;
  baseRevision: number;
  baseWipOid: string;
  baseLeaseEpoch: number;
  remoteUpdate: {
    revision: number;
    wipOid: string;
    leaseEpoch: number;
  } | null;
}

export interface AppV2Change {
  path: string;
  previousPath?: string;
  status: string;
}

export interface AppV2Availability {
  enabled: boolean;
  sandboxAvailable: boolean;
  sandboxProvider: "e2b" | "off";
  githubPushAvailable: boolean;
  loaded: boolean;
  loading: boolean;
  error: string | null;
}

export type AppV2SessionStatus =
  | "active"
  | "paused"
  | "unsynced"
  | "conflict"
  | "provisioning"
  | "revoked"
  | "destroyed"
  | "error";

export interface AppV2Session {
  id?: string;
  worktreeId: string;
  provider: string;
  sandboxId: string;
  generation: number;
  leaseEpoch: number;
  appliedWipOid: string;
  recoveryRef?: string;
  status: AppV2SessionStatus;
  lastActiveAt: string;
}

export type AppV2SessionDurability =
  | {
      status: "durable";
      revision: { wipOid: string; revision: number };
    }
  | {
      status: "conflict";
      recoveryRef: string;
    };

export interface AppV2SessionCommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  cancelled: boolean;
  outputTruncated: boolean;
  excludedPaths: string[];
  durability: AppV2SessionDurability;
  operation: "exec" | "install";
}

export interface AppV2SessionFlush {
  excludedPaths: string[];
  durability: AppV2SessionDurability;
}

export interface AppV2SessionIssue {
  kind: "provider_unavailable" | "conflict" | "error";
  message: string;
  retryable?: boolean;
  recoveryRef?: string;
}

interface MutationConflict {
  message: string;
  occurredAt: number;
}

type MutationResult = "saved" | "conflict" | "error";

interface AppV2State {
  availabilityByWorkspace: Record<string, AppV2Availability>;
  projectsByWorkspace: Record<string, AppV2Project[]>;
  projectsById: Record<string, AppV2Project>;
  worktreesByProject: Record<string, AppV2Worktree>;
  conversationBranchesByProject: Record<string, AppV2ConversationBranch[]>;
  treesByProject: Record<string, AppV2TreeEntry[]>;
  filesByKey: Record<string, AppV2File>;
  editorBuffersByKey: Record<string, AppV2EditorBuffer>;
  statusByProject: Record<string, { clean: boolean; changes: AppV2Change[] }>;
  sessionsByProject: Record<string, AppV2Session>;
  sessionCommandsByProject: Record<string, AppV2SessionCommandResult>;
  sessionFlushesByProject: Record<string, AppV2SessionFlush>;
  sessionIssuesByProject: Record<string, AppV2SessionIssue>;
  loadingByKey: Record<string, boolean>;
  errorsByKey: Record<string, string | null>;
  conflictsByKey: Record<string, MutationConflict>;
}

interface AppV2Actions {
  fetchStatus: (workspaceId: string) => Promise<boolean>;
  fetchStatusWithRetry: (workspaceId: string) => Promise<boolean>;
  getSession: (
    workspaceId: string,
    projectId: string,
  ) => Promise<AppV2Session | null>;
  ensureSession: (
    workspaceId: string,
    projectId: string,
  ) => Promise<AppV2Session | null>;
  execSession: (
    workspaceId: string,
    projectId: string,
    argv: string[],
  ) => Promise<AppV2SessionCommandResult | null>;
  installPackages: (
    workspaceId: string,
    projectId: string,
    packages: string[],
  ) => Promise<AppV2SessionCommandResult | null>;
  flushSession: (
    workspaceId: string,
    projectId: string,
  ) => Promise<AppV2SessionFlush | null>;
  pauseSession: (
    workspaceId: string,
    projectId: string,
  ) => Promise<AppV2SessionFlush | null>;
  destroySession: (
    workspaceId: string,
    projectId: string,
  ) => Promise<AppV2SessionFlush | null>;
  listProjects: (workspaceId: string) => Promise<AppV2Project[]>;
  createProject: (
    workspaceId: string,
    input: {
      title: string;
      description?: string;
      access: "private" | "workspace";
      workspaceRole?: "viewer" | "editor";
    },
  ) => Promise<AppV2Project | null>;
  getProject: (
    workspaceId: string,
    projectId: string,
  ) => Promise<AppV2Project | null>;
  getWorktree: (
    workspaceId: string,
    projectId: string,
  ) => Promise<AppV2Worktree | null>;
  getOrCreateWorktree: (
    workspaceId: string,
    projectId: string,
  ) => Promise<AppV2Worktree | null>;
  listConversationBranches: (
    workspaceId: string,
    projectId: string,
  ) => Promise<AppV2ConversationBranch[]>;
  fetchGitHubStatus: (workspaceId: string) => Promise<AppV2GitHubStatus | null>;
  fetchGitHubRepos: (
    workspaceId: string,
    installationId: number,
  ) => Promise<AppV2GitHubRepo[]>;
  fetchGitHubBranches: (
    workspaceId: string,
    input: { installationId: number; owner: string; repo: string },
  ) => Promise<string[]>;
  bindGitHub: (
    workspaceId: string,
    projectId: string,
    binding: Omit<AppV2GitHubBinding, "boundAt" | "boundBy" | "generation">,
  ) => Promise<AppV2Project | null>;
  unbindGitHub: (
    workspaceId: string,
    projectId: string,
  ) => Promise<AppV2Project | null>;
  pushGitHubConversation: (
    workspaceId: string,
    projectId: string,
    chatId: string,
  ) => Promise<boolean>;
  loadTree: (
    workspaceId: string,
    projectId: string,
  ) => Promise<AppV2TreeEntry[]>;
  loadFile: (
    workspaceId: string,
    projectId: string,
    path: string,
  ) => Promise<AppV2File | null>;
  loadStatus: (
    workspaceId: string,
    projectId: string,
  ) => Promise<{ clean: boolean; changes: AppV2Change[] } | null>;
  updateEditorBuffer: (
    projectId: string,
    path: string,
    content: string,
  ) => void;
  saveFile: (
    workspaceId: string,
    projectId: string,
    path: string,
  ) => Promise<MutationResult>;
  reloadFile: (
    workspaceId: string,
    projectId: string,
    path: string,
    options?: { discardDirty?: boolean },
  ) => Promise<AppV2File | null>;
  closeEditorBuffer: (projectId: string, path: string) => void;
  commit: (
    workspaceId: string,
    projectId: string,
    message: string,
  ) => Promise<MutationResult>;
  discard: (workspaceId: string, projectId: string) => Promise<MutationResult>;
  refreshProject: (workspaceId: string, projectId: string) => Promise<void>;
  refreshLoadedProjects: (workspaceId: string) => Promise<void>;
  clearConflict: (key: string) => void;
}

type AppV2Store = AppV2State & AppV2Actions;

const initialState: AppV2State = {
  availabilityByWorkspace: {},
  projectsByWorkspace: {},
  projectsById: {},
  worktreesByProject: {},
  conversationBranchesByProject: {},
  treesByProject: {},
  filesByKey: {},
  editorBuffersByKey: {},
  statusByProject: {},
  sessionsByProject: {},
  sessionCommandsByProject: {},
  sessionFlushesByProject: {},
  sessionIssuesByProject: {},
  loadingByKey: {},
  errorsByKey: {},
  conflictsByKey: {},
};

export const appV2FileKey = (projectId: string, path: string): string =>
  `${projectId}\u0000${path}`;

const projectPath = (workspaceId: string, projectId?: string): string =>
  `/workspaces/${workspaceId}/apps-v2${projectId ? `/${projectId}` : ""}`;

const errorMessage = (error: unknown, fallback: string): string =>
  error instanceof Error && error.message.trim() ? error.message : fallback;

interface AppV2SessionApiBody {
  success: boolean;
  error?: string;
  code?: "provider_unavailable";
  retryable?: boolean;
  recoveryRef?: string;
  session?: AppV2Session;
  worktree?: AppV2Worktree;
  result?: Omit<AppV2SessionCommandResult, "operation">;
  flush?: AppV2SessionFlush;
}

const statusRequests = new Map<string, Promise<boolean>>();
const statusRetryRequests = new Map<string, Promise<boolean>>();
const STATUS_RETRY_DELAYS_MS = [250, 1_000] as const;
const wait = (delayMs: number) =>
  new Promise<void>(resolve => {
    setTimeout(resolve, delayMs);
  });

export const useAppV2Store = create<AppV2Store>()(
  immer((set, get) => {
    const setLoading = (key: string, loading: boolean) => {
      set(state => {
        if (loading) state.loadingByKey[key] = true;
        else delete state.loadingByKey[key];
      });
    };

    const recordError = (key: string, error: unknown, fallback: string) => {
      set(state => {
        state.errorsByKey[key] = errorMessage(error, fallback);
      });
    };

    const recordConflict = (key: string, message: string) => {
      set(state => {
        state.conflictsByKey[key] = {
          message,
          occurredAt: Date.now(),
        };
      });
    };

    const recordSessionIssue = (
      projectId: string,
      status: number,
      body: AppV2SessionApiBody,
      fallback: string,
    ) => {
      const recoveryRef =
        body.recoveryRef ??
        (body.result?.durability.status === "conflict"
          ? body.result.durability.recoveryRef
          : body.flush?.durability.status === "conflict"
            ? body.flush.durability.recoveryRef
            : undefined);
      const issue: AppV2SessionIssue = {
        kind:
          status === 503 || body.code === "provider_unavailable"
            ? "provider_unavailable"
            : status === 409 || recoveryRef
              ? "conflict"
              : "error",
        message: body.error ?? fallback,
        retryable: body.retryable,
        recoveryRef,
      };
      set(state => {
        state.sessionIssuesByProject[projectId] = issue;
        state.errorsByKey[`session:${projectId}`] = issue.message;
      });
    };

    const clearSessionIssue = (projectId: string) => {
      set(state => {
        delete state.sessionIssuesByProject[projectId];
        state.errorsByKey[`session:${projectId}`] = null;
      });
    };

    const applySessionBody = (projectId: string, body: AppV2SessionApiBody) => {
      if (body.worktree) applyWorktree(projectId, body.worktree);
      if (body.session) {
        set(state => {
          state.sessionsByProject[projectId] = body.session as AppV2Session;
        });
      }
    };

    const requireSandbox = async (
      workspaceId: string,
      projectId: string,
    ): Promise<boolean> => {
      if (!get().availabilityByWorkspace[workspaceId]?.loaded) {
        await get().fetchStatus(workspaceId);
      }
      const availability = get().availabilityByWorkspace[workspaceId];
      if (availability?.sandboxAvailable) return true;
      recordSessionIssue(
        projectId,
        503,
        {
          success: false,
          code: "provider_unavailable",
          error: "Isolated execution is unavailable for this workspace",
        },
        "Isolated execution is unavailable for this workspace",
      );
      return false;
    };

    const mutationState = (projectId: string) => {
      const worktree = get().worktreesByProject[projectId];
      if (!worktree) return null;
      return {
        worktree,
        input: {
          ifRevision: worktree.revision,
          expectedWipOid: worktree.wipOid,
          leaseEpoch: worktree.leaseEpoch,
        },
      };
    };

    const applyWorktree = (projectId: string, worktree: AppV2Worktree) => {
      set(state => {
        const current = state.worktreesByProject[projectId];
        if (current && current.revision > worktree.revision) return;
        state.worktreesByProject[projectId] = worktree;
        for (const buffer of Object.values(state.editorBuffersByKey)) {
          if (
            buffer.projectId === projectId &&
            buffer.dirty &&
            (buffer.baseRevision !== worktree.revision ||
              buffer.baseWipOid !== worktree.wipOid ||
              buffer.baseLeaseEpoch !== worktree.leaseEpoch)
          ) {
            buffer.remoteUpdate = {
              revision: worktree.revision,
              wipOid: worktree.wipOid,
              leaseEpoch: worktree.leaseEpoch,
            };
          }
        }
      });
    };

    const fetchFile = async (
      workspaceId: string,
      projectId: string,
      path: string,
      force: boolean,
      preserveDirty = false,
    ): Promise<AppV2File | null> => {
      const bufferKey = appV2FileKey(projectId, path);
      if (!force && get().editorBuffersByKey[bufferKey]) {
        return get().filesByKey[bufferKey] ?? null;
      }
      const worktree = get().worktreesByProject[projectId];
      if (!worktree) return null;
      const loadingKey = `file:${bufferKey}`;
      setLoading(loadingKey, true);
      try {
        const response = await apiClient.get<
          AppV2File & { success: true; worktree: AppV2Worktree }
        >(
          `${projectPath(workspaceId, projectId)}/worktrees/${worktree.id}/file`,
          { path },
        );
        const file: AppV2File = {
          path: response.path,
          oid: response.oid,
          mode: response.mode,
          content: response.content,
        };
        applyWorktree(projectId, response.worktree);
        const latestWorktree =
          get().worktreesByProject[projectId] ?? response.worktree;
        const hasNewerWorktree =
          latestWorktree.revision !== response.worktree.revision ||
          latestWorktree.wipOid !== response.worktree.wipOid ||
          latestWorktree.leaseEpoch !== response.worktree.leaseEpoch;
        set(state => {
          state.filesByKey[bufferKey] = file;
          const currentBuffer = state.editorBuffersByKey[bufferKey];
          if (preserveDirty && currentBuffer?.dirty) {
            currentBuffer.remoteUpdate = {
              revision: response.worktree.revision,
              wipOid: response.worktree.wipOid,
              leaseEpoch: response.worktree.leaseEpoch,
            };
            state.errorsByKey[loadingKey] = null;
            return;
          }
          state.editorBuffersByKey[bufferKey] = {
            projectId,
            path,
            content: file.content,
            dirty: false,
            baseRevision: response.worktree.revision,
            baseWipOid: response.worktree.wipOid,
            baseLeaseEpoch: response.worktree.leaseEpoch,
            remoteUpdate: hasNewerWorktree
              ? {
                  revision: latestWorktree.revision,
                  wipOid: latestWorktree.wipOid,
                  leaseEpoch: latestWorktree.leaseEpoch,
                }
              : null,
          };
          state.errorsByKey[loadingKey] = null;
          delete state.conflictsByKey[bufferKey];
        });
        return file;
      } catch (error) {
        recordError(loadingKey, error, "Unable to load file");
        return null;
      } finally {
        setLoading(loadingKey, false);
      }
    };

    const refreshWorktreeViews = async (
      workspaceId: string,
      projectId: string,
    ) => {
      await Promise.all([
        get().loadTree(workspaceId, projectId),
        get().loadStatus(workspaceId, projectId),
      ]);
      const worktree = get().worktreesByProject[projectId];
      if (!worktree) return;
      const remotePaths = new Set(
        (get().treesByProject[projectId] ?? []).map(entry => entry.path),
      );
      const candidates = Object.entries(get().editorBuffersByKey).filter(
        ([, buffer]) =>
          buffer.projectId === projectId &&
          !buffer.dirty &&
          (buffer.baseRevision !== worktree.revision ||
            buffer.baseWipOid !== worktree.wipOid ||
            buffer.baseLeaseEpoch !== worktree.leaseEpoch),
      );
      await Promise.all(
        candidates.map(async ([bufferKey, buffer]) => {
          if (!remotePaths.has(buffer.path)) {
            set(state => {
              const current = state.editorBuffersByKey[bufferKey];
              if (!current || current.dirty) return;
              delete state.editorBuffersByKey[bufferKey];
              delete state.filesByKey[bufferKey];
              delete state.conflictsByKey[bufferKey];
              state.errorsByKey[`file:${bufferKey}`] =
                "File no longer exists in this worktree";
            });
            return;
          }
          await fetchFile(workspaceId, projectId, buffer.path, true, true);
        }),
      );
    };

    const runSessionCommand = async (
      workspaceId: string,
      projectId: string,
      operation: "exec" | "install",
      body: { argv: string[]; cwd: string } | { packages: string[] },
    ): Promise<AppV2SessionCommandResult | null> => {
      if (!(await requireSandbox(workspaceId, projectId))) return null;
      const key = `session-command:${projectId}`;
      setLoading(key, true);
      try {
        const response = await apiClient.postWithStatus<AppV2SessionApiBody>(
          `${projectPath(workspaceId, projectId)}/session/${operation}`,
          body,
          { alsoOk: [409, 503] },
        );
        applySessionBody(projectId, response.body);
        const result = response.body.result
          ? { ...response.body.result, operation }
          : null;
        if (result) {
          set(state => {
            state.sessionCommandsByProject[projectId] = result;
          });
        }
        if (response.status !== 200 || !response.body.success) {
          recordSessionIssue(
            projectId,
            response.status,
            response.body,
            `Unable to ${operation === "exec" ? "run command" : "install packages"}`,
          );
          return result;
        }
        clearSessionIssue(projectId);
        if (result?.durability.status === "durable") {
          await get().getWorktree(workspaceId, projectId);
          await refreshWorktreeViews(workspaceId, projectId);
        }
        return result;
      } catch (error) {
        recordSessionIssue(
          projectId,
          error instanceof ApiError ? error.status : 500,
          { success: false, error: errorMessage(error, "Session failed") },
          "Session failed",
        );
        return null;
      } finally {
        setLoading(key, false);
      }
    };

    const loadSession = async (
      workspaceId: string,
      projectId: string,
      ensure: boolean,
    ): Promise<AppV2Session | null> => {
      if (!(await requireSandbox(workspaceId, projectId))) return null;
      const key = `session:${projectId}`;
      setLoading(key, true);
      try {
        const path = `${projectPath(workspaceId, projectId)}/session`;
        const response = ensure
          ? await apiClient.postWithStatus<AppV2SessionApiBody>(
              path,
              undefined,
              { alsoOk: [409, 503] },
            )
          : await apiClient.getWithStatus<AppV2SessionApiBody>(path, {
              alsoOk: [404, 409, 503],
            });
        if (response.status === 404) {
          set(state => {
            delete state.sessionsByProject[projectId];
          });
          clearSessionIssue(projectId);
          return null;
        }
        applySessionBody(projectId, response.body);
        if (response.status !== 200 || !response.body.success) {
          recordSessionIssue(
            projectId,
            response.status,
            response.body,
            `Unable to ${ensure ? "start" : "load"} session`,
          );
          return response.body.session ?? null;
        }
        clearSessionIssue(projectId);
        return response.body.session ?? null;
      } catch (error) {
        recordSessionIssue(
          projectId,
          error instanceof ApiError ? error.status : 500,
          {
            success: false,
            error: errorMessage(error, "Unable to load session"),
          },
          "Unable to load session",
        );
        return null;
      } finally {
        setLoading(key, false);
      }
    };

    const runSessionLifecycle = async (
      workspaceId: string,
      projectId: string,
      action: "flush" | "pause" | "destroy",
    ): Promise<AppV2SessionFlush | null> => {
      if (!(await requireSandbox(workspaceId, projectId))) return null;
      const key = `session-${action}:${projectId}`;
      setLoading(key, true);
      try {
        const path =
          action === "destroy"
            ? `${projectPath(workspaceId, projectId)}/session`
            : `${projectPath(workspaceId, projectId)}/session/${action}`;
        const response =
          action === "destroy"
            ? await apiClient.deleteWithStatus<AppV2SessionApiBody>(path, {
                alsoOk: [409, 503],
              })
            : await apiClient.postWithStatus<AppV2SessionApiBody>(
                path,
                undefined,
                { alsoOk: [409, 503] },
              );
        applySessionBody(projectId, response.body);
        if (response.body.flush) {
          set(state => {
            state.sessionFlushesByProject[projectId] = response.body
              .flush as AppV2SessionFlush;
          });
        }
        if (response.status !== 200 || !response.body.success) {
          recordSessionIssue(
            projectId,
            response.status,
            response.body,
            `Unable to ${action} session`,
          );
          return response.body.flush ?? null;
        }
        clearSessionIssue(projectId);
        if (response.body.worktree) {
          await refreshWorktreeViews(workspaceId, projectId);
        }
        return response.body.flush ?? null;
      } catch (error) {
        recordSessionIssue(
          projectId,
          error instanceof ApiError ? error.status : 500,
          {
            success: false,
            error: errorMessage(error, `Unable to ${action} session`),
          },
          `Unable to ${action} session`,
        );
        return null;
      } finally {
        setLoading(key, false);
      }
    };

    return {
      ...initialState,

      fetchStatus: async workspaceId => {
        const availability = get().availabilityByWorkspace[workspaceId];
        if (availability?.loaded && !availability.error) {
          return availability.enabled;
        }
        const pending = statusRequests.get(workspaceId);
        if (pending) return pending;
        const request = (async () => {
          set(state => {
            state.availabilityByWorkspace[workspaceId] = {
              enabled: false,
              sandboxAvailable: false,
              sandboxProvider: "off",
              githubPushAvailable: false,
              loaded: false,
              loading: true,
              error: null,
            };
          });
          try {
            const response = await apiClient.get<{
              enabled: boolean;
              sandboxAvailable: boolean;
              sandboxProvider: "e2b" | "off";
              githubPushAvailable: boolean;
            }>(`${projectPath(workspaceId)}/status`);
            set(state => {
              state.availabilityByWorkspace[workspaceId] = {
                enabled: response.enabled,
                sandboxAvailable: response.sandboxAvailable,
                sandboxProvider: response.sandboxProvider,
                githubPushAvailable: response.githubPushAvailable,
                loaded: true,
                loading: false,
                error: null,
              };
            });
            return response.enabled;
          } catch (error) {
            set(state => {
              state.availabilityByWorkspace[workspaceId] = {
                enabled: false,
                sandboxAvailable: false,
                sandboxProvider: "off",
                githubPushAvailable: false,
                loaded: false,
                loading: false,
                error: errorMessage(
                  error,
                  "Unable to check App Projects availability",
                ),
              };
            });
            return false;
          } finally {
            statusRequests.delete(workspaceId);
          }
        })();
        statusRequests.set(workspaceId, request);
        return request;
      },

      fetchStatusWithRetry: async workspaceId => {
        const availability = get().availabilityByWorkspace[workspaceId];
        if (availability?.loaded && !availability.error) {
          return availability.enabled;
        }
        const pending = statusRetryRequests.get(workspaceId);
        if (pending) return pending;
        const request = (async () => {
          try {
            for (
              let attempt = 0;
              attempt <= STATUS_RETRY_DELAYS_MS.length;
              attempt += 1
            ) {
              if (attempt > 0) {
                await wait(STATUS_RETRY_DELAYS_MS[attempt - 1]);
              }
              const enabled = await get().fetchStatus(workspaceId);
              if (get().availabilityByWorkspace[workspaceId]?.loaded) {
                return enabled;
              }
            }
            return false;
          } finally {
            statusRetryRequests.delete(workspaceId);
          }
        })();
        statusRetryRequests.set(workspaceId, request);
        return request;
      },

      getSession: (workspaceId, projectId) =>
        loadSession(workspaceId, projectId, false),

      ensureSession: (workspaceId, projectId) =>
        loadSession(workspaceId, projectId, true),

      execSession: (workspaceId, projectId, argv) =>
        runSessionCommand(workspaceId, projectId, "exec", {
          argv,
          cwd: "",
        }),

      installPackages: (workspaceId, projectId, packages) =>
        runSessionCommand(workspaceId, projectId, "install", { packages }),

      flushSession: (workspaceId, projectId) =>
        runSessionLifecycle(workspaceId, projectId, "flush"),

      pauseSession: (workspaceId, projectId) =>
        runSessionLifecycle(workspaceId, projectId, "pause"),

      destroySession: (workspaceId, projectId) =>
        runSessionLifecycle(workspaceId, projectId, "destroy"),

      listProjects: async workspaceId => {
        const key = `list:${workspaceId}`;
        setLoading(key, true);
        try {
          const response = await apiClient.get<{
            success: true;
            projects: AppV2Project[];
          }>(projectPath(workspaceId));
          set(state => {
            const returnedIds = new Set(
              response.projects.map(project => project.id),
            );
            for (const existing of state.projectsByWorkspace[workspaceId] ??
              []) {
              if (!returnedIds.has(existing.id)) {
                delete state.projectsById[existing.id];
              }
            }
            state.projectsByWorkspace[workspaceId] = response.projects;
            for (const project of response.projects) {
              state.projectsById[project.id] = project;
            }
            state.errorsByKey[key] = null;
          });
          return response.projects;
        } catch (error) {
          recordError(key, error, "Unable to load App Projects");
          return [];
        } finally {
          setLoading(key, false);
        }
      },

      createProject: async (workspaceId, input) => {
        const key = `create:${workspaceId}`;
        setLoading(key, true);
        try {
          const response = await apiClient.post<{
            success: true;
            project: AppV2Project;
          }>(projectPath(workspaceId), input);
          set(state => {
            const current = state.projectsByWorkspace[workspaceId] ?? [];
            state.projectsByWorkspace[workspaceId] = [
              response.project,
              ...current.filter(project => project.id !== response.project.id),
            ];
            state.projectsById[response.project.id] = response.project;
            state.errorsByKey[key] = null;
          });
          return response.project;
        } catch (error) {
          recordError(key, error, "Unable to create App Project");
          return null;
        } finally {
          setLoading(key, false);
        }
      },

      getProject: async (workspaceId, projectId) => {
        const key = `project:${projectId}`;
        setLoading(key, true);
        try {
          const response = await apiClient.get<{
            success: true;
            project: AppV2Project;
          }>(projectPath(workspaceId, projectId));
          set(state => {
            state.projectsById[projectId] = response.project;
            state.errorsByKey[key] = null;
          });
          return response.project;
        } catch (error) {
          recordError(key, error, "Unable to load App Project");
          return null;
        } finally {
          setLoading(key, false);
        }
      },

      getWorktree: async (workspaceId, projectId) => {
        const key = `worktree:${projectId}`;
        try {
          const response = await apiClient.get<{
            success: true;
            worktree: AppV2Worktree;
          }>(`${projectPath(workspaceId, projectId)}/worktree`);
          applyWorktree(projectId, response.worktree);
          return response.worktree;
        } catch (error) {
          if (error instanceof ApiError && error.status === 404) return null;
          recordError(key, error, "Unable to load personal worktree");
          return null;
        }
      },

      getOrCreateWorktree: async (workspaceId, projectId) => {
        const key = `worktree:${projectId}`;
        setLoading(key, true);
        try {
          const response = await apiClient.post<{
            success: true;
            worktree: AppV2Worktree;
          }>(`${projectPath(workspaceId, projectId)}/worktree`);
          applyWorktree(projectId, response.worktree);
          set(state => {
            state.errorsByKey[key] = null;
          });
          return response.worktree;
        } catch (error) {
          recordError(key, error, "Unable to create personal worktree");
          return null;
        } finally {
          setLoading(key, false);
        }
      },

      listConversationBranches: async (workspaceId, projectId) => {
        const key = `conversation-branches:${projectId}`;
        try {
          const response = await apiClient.get<{
            success: true;
            branches: AppV2ConversationBranch[];
          }>(`${projectPath(workspaceId, projectId)}/conversation-branches`);
          set(state => {
            state.conversationBranchesByProject[projectId] = response.branches;
            state.errorsByKey[key] = null;
          });
          return response.branches;
        } catch (error) {
          recordError(key, error, "Unable to load conversation branches");
          return [];
        }
      },

      fetchGitHubStatus: async workspaceId => {
        const key = `github-status:${workspaceId}`;
        if (get().loadingByKey[key]) return null;
        setLoading(key, true);
        try {
          const response = await apiClient.get<
            AppV2GitHubStatus & { success: true }
          >(`/workspaces/${workspaceId}/dbt/github/status`);
          set(state => {
            state.errorsByKey[key] = null;
          });
          return response;
        } catch (error) {
          recordError(key, error, "Unable to load GitHub installations");
          return null;
        } finally {
          setLoading(key, false);
        }
      },

      fetchGitHubRepos: async (workspaceId, installationId) => {
        const key = `github-repos:${installationId}`;
        if (get().loadingByKey[key]) return [];
        setLoading(key, true);
        try {
          const response = await apiClient.get<{
            success: true;
            repos: AppV2GitHubRepo[];
          }>(`/workspaces/${workspaceId}/dbt/github/repos`, {
            installationId: String(installationId),
          });
          set(state => {
            state.errorsByKey[key] = null;
          });
          return response.repos;
        } catch (error) {
          recordError(key, error, "Unable to load GitHub repositories");
          return [];
        } finally {
          setLoading(key, false);
        }
      },

      fetchGitHubBranches: async (workspaceId, input) => {
        const key = `github-branches:${input.owner}/${input.repo}`;
        if (get().loadingByKey[key]) return [];
        setLoading(key, true);
        try {
          const response = await apiClient.get<{
            success: true;
            branches: string[];
          }>(`/workspaces/${workspaceId}/dbt/github/branches`, {
            installationId: String(input.installationId),
            owner: input.owner,
            repo: input.repo,
          });
          set(state => {
            state.errorsByKey[key] = null;
          });
          return response.branches;
        } catch (error) {
          recordError(key, error, "Unable to load GitHub branches");
          return [];
        } finally {
          setLoading(key, false);
        }
      },

      bindGitHub: async (workspaceId, projectId, binding) => {
        const key = `github-binding:${projectId}`;
        if (get().loadingByKey[key]) return null;
        setLoading(key, true);
        try {
          const response = await apiClient.put<{
            success: true;
            project: AppV2Project;
          }>(`${projectPath(workspaceId, projectId)}/github`, binding);
          set(state => {
            state.projectsById[projectId] = response.project;
            state.errorsByKey[key] = null;
          });
          return response.project;
        } catch (error) {
          recordError(key, error, "Unable to bind GitHub repository");
          return null;
        } finally {
          setLoading(key, false);
        }
      },

      unbindGitHub: async (workspaceId, projectId) => {
        const key = `github-binding:${projectId}`;
        if (get().loadingByKey[key]) return null;
        setLoading(key, true);
        try {
          const response = await apiClient.delete<{
            success: true;
            project: AppV2Project;
          }>(`${projectPath(workspaceId, projectId)}/github`);
          set(state => {
            state.projectsById[projectId] = response.project;
            state.errorsByKey[key] = null;
          });
          return response.project;
        } catch (error) {
          recordError(key, error, "Unable to remove GitHub binding");
          return null;
        } finally {
          setLoading(key, false);
        }
      },

      pushGitHubConversation: async (workspaceId, projectId, chatId) => {
        const key = `github-push:${projectId}:${chatId}`;
        if (get().loadingByKey[key]) return false;
        setLoading(key, true);
        try {
          const response = await apiClient.post<{
            success: boolean;
            status: "local_only" | "pushed" | "remote_failed" | "conflict";
            error?: string;
          }>(`${projectPath(workspaceId, projectId)}/github/push`, { chatId });
          if (!response.success) {
            set(state => {
              state.errorsByKey[key] =
                response.error ?? `GitHub push ${response.status}`;
            });
            return false;
          }
          await get().listConversationBranches(workspaceId, projectId);
          set(state => {
            state.errorsByKey[key] = null;
          });
          return true;
        } catch (error) {
          recordError(key, error, "Unable to push conversation branch");
          return false;
        } finally {
          setLoading(key, false);
        }
      },

      loadTree: async (workspaceId, projectId) => {
        const worktree = get().worktreesByProject[projectId];
        if (!worktree) return [];
        const key = `tree:${projectId}`;
        setLoading(key, true);
        try {
          const response = await apiClient.get<{
            success: true;
            worktree: AppV2Worktree;
            entries: AppV2TreeEntry[];
          }>(
            `${projectPath(workspaceId, projectId)}/worktrees/${worktree.id}/tree`,
          );
          applyWorktree(projectId, response.worktree);
          set(state => {
            state.treesByProject[projectId] = response.entries;
            state.errorsByKey[key] = null;
          });
          return response.entries;
        } catch (error) {
          recordError(key, error, "Unable to load project files");
          return [];
        } finally {
          setLoading(key, false);
        }
      },

      loadFile: async (workspaceId, projectId, path) => {
        return fetchFile(workspaceId, projectId, path, false);
      },

      loadStatus: async (workspaceId, projectId) => {
        const worktree = get().worktreesByProject[projectId];
        if (!worktree) return null;
        const key = `git-status:${projectId}`;
        try {
          const response = await apiClient.get<{
            success: true;
            worktree: AppV2Worktree;
            clean: boolean;
            changes: AppV2Change[];
          }>(
            `${projectPath(workspaceId, projectId)}/worktrees/${worktree.id}/status`,
          );
          const status = { clean: response.clean, changes: response.changes };
          applyWorktree(projectId, response.worktree);
          set(state => {
            state.statusByProject[projectId] = status;
            state.errorsByKey[key] = null;
          });
          return status;
        } catch (error) {
          recordError(key, error, "Unable to load Git status");
          return null;
        }
      },

      updateEditorBuffer: (projectId, path, content) => {
        const key = appV2FileKey(projectId, path);
        set(state => {
          const buffer = state.editorBuffersByKey[key];
          if (!buffer) return;
          buffer.content = content;
          buffer.dirty = true;
        });
      },

      saveFile: async (workspaceId, projectId, path) => {
        const key = appV2FileKey(projectId, path);
        const buffer = get().editorBuffersByKey[key];
        const worktree = get().worktreesByProject[projectId];
        if (!buffer || !worktree) return "error";
        try {
          const response = await apiClient.putWithStatus<{
            success: boolean;
            error?: string;
            worktree?: AppV2Worktree;
          }>(
            `${projectPath(workspaceId, projectId)}/worktrees/${worktree.id}/file`,
            {
              ifRevision: buffer.baseRevision,
              expectedWipOid: buffer.baseWipOid,
              leaseEpoch: buffer.baseLeaseEpoch,
              path,
              content: buffer.content,
              executable: get().filesByKey[key]?.mode === "executable",
            },
            { alsoOk: [409] },
          );
          if (response.status === 409 || !response.body.worktree) {
            recordConflict(
              key,
              response.body.error ??
                "This file changed elsewhere. Your edits were not overwritten.",
            );
            return "conflict";
          }
          const updatedWorktree = response.body.worktree;
          applyWorktree(projectId, updatedWorktree);
          set(state => {
            const existing = state.filesByKey[key];
            const savedBuffer = state.editorBuffersByKey[key];
            if (existing) existing.content = buffer.content;
            if (savedBuffer) {
              savedBuffer.dirty = savedBuffer.content !== buffer.content;
              savedBuffer.baseRevision = updatedWorktree.revision;
              savedBuffer.baseWipOid = updatedWorktree.wipOid;
              savedBuffer.baseLeaseEpoch = updatedWorktree.leaseEpoch;
              savedBuffer.remoteUpdate = null;
            }
            delete state.conflictsByKey[key];
          });
          await refreshWorktreeViews(workspaceId, projectId);
          return "saved";
        } catch (error) {
          recordError(`file:${key}`, error, "Unable to save file");
          return "error";
        }
      },

      reloadFile: async (workspaceId, projectId, path, options) => {
        const key = appV2FileKey(projectId, path);
        if (
          get().editorBuffersByKey[key]?.dirty &&
          options?.discardDirty !== true
        ) {
          return get().filesByKey[key] ?? null;
        }
        return fetchFile(workspaceId, projectId, path, true);
      },

      closeEditorBuffer: (projectId, path) => {
        const key = appV2FileKey(projectId, path);
        set(state => {
          delete state.editorBuffersByKey[key];
          delete state.filesByKey[key];
          delete state.conflictsByKey[key];
          delete state.errorsByKey[`file:${key}`];
        });
      },

      commit: async (workspaceId, projectId, message) => {
        const mutation = mutationState(projectId);
        if (!mutation) return "error";
        try {
          const response = await apiClient.postWithStatus<{
            success: boolean;
            error?: string;
            worktree?: AppV2Worktree;
          }>(
            `${projectPath(workspaceId, projectId)}/worktrees/${mutation.worktree.id}/commit`,
            { ...mutation.input, message },
            { alsoOk: [409] },
          );
          if (response.status === 409 || !response.body.worktree) {
            recordConflict(
              projectId,
              response.body.error ??
                "The worktree changed elsewhere. Nothing was committed.",
            );
            return "conflict";
          }
          applyWorktree(projectId, response.body.worktree);
          await Promise.all([
            get().getProject(workspaceId, projectId),
            refreshWorktreeViews(workspaceId, projectId),
          ]);
          set(state => {
            delete state.conflictsByKey[projectId];
          });
          return "saved";
        } catch (error) {
          recordError(`commit:${projectId}`, error, "Unable to commit changes");
          return "error";
        }
      },

      discard: async (workspaceId, projectId) => {
        const mutation = mutationState(projectId);
        if (!mutation) return "error";
        try {
          const response = await apiClient.postWithStatus<{
            success: boolean;
            error?: string;
            worktree?: AppV2Worktree;
          }>(
            `${projectPath(workspaceId, projectId)}/worktrees/${mutation.worktree.id}/discard`,
            mutation.input,
            { alsoOk: [409] },
          );
          if (response.status === 409 || !response.body.worktree) {
            recordConflict(
              projectId,
              response.body.error ??
                "The worktree changed elsewhere. Nothing was discarded.",
            );
            return "conflict";
          }
          applyWorktree(projectId, response.body.worktree);
          set(state => {
            delete state.conflictsByKey[projectId];
          });
          await refreshWorktreeViews(workspaceId, projectId);
          return "saved";
        } catch (error) {
          recordError(
            `discard:${projectId}`,
            error,
            "Unable to discard changes",
          );
          return "error";
        }
      },

      refreshProject: async (workspaceId, projectId) => {
        await Promise.all([
          get().getProject(workspaceId, projectId),
          get().listConversationBranches(workspaceId, projectId),
        ]);
        if (!get().worktreesByProject[projectId]) {
          await get().getWorktree(workspaceId, projectId);
        }
        if (get().worktreesByProject[projectId]) {
          await refreshWorktreeViews(workspaceId, projectId);
        }
      },

      refreshLoadedProjects: async workspaceId => {
        const state = get();
        const projectIds = Object.keys(state.worktreesByProject).filter(
          projectId =>
            state.projectsById[projectId]?.workspaceId === workspaceId,
        );
        await Promise.allSettled(
          projectIds.map(projectId =>
            get().refreshProject(workspaceId, projectId),
          ),
        );
      },

      clearConflict: key => {
        set(state => {
          delete state.conflictsByKey[key];
        });
      },
    };
  }),
);
