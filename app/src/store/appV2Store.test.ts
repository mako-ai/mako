import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiClient } from "../lib/api-client";
import {
  appV2FileKey,
  useAppV2Store,
  type AppV2EditorBuffer,
  type AppV2File,
  type AppV2Worktree,
} from "./appV2Store";

const worktree: AppV2Worktree = {
  id: "worktree-1",
  projectId: "project-1",
  actorId: "user-1",
  branch: "main",
  baseSha: "a".repeat(40),
  wipOid: "b".repeat(40),
  revision: 7,
  leaseEpoch: 3,
  status: "active",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const file: AppV2File = {
  path: "src/App.tsx",
  oid: "c".repeat(40),
  mode: "regular",
  content: "server content",
};

const buffer: AppV2EditorBuffer = {
  projectId: worktree.projectId,
  path: file.path,
  content: "local edits",
  dirty: true,
  baseRevision: worktree.revision,
  baseWipOid: worktree.wipOid,
  baseLeaseEpoch: worktree.leaseEpoch,
  remoteUpdate: null,
};

describe("appV2Store conflict handling", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    const key = appV2FileKey(worktree.projectId, file.path);
    useAppV2Store.setState({
      availabilityByWorkspace: {},
      projectsByWorkspace: {},
      projectsById: {},
      worktreesByProject: { [worktree.projectId]: worktree },
      treesByProject: {},
      filesByKey: { [key]: file },
      editorBuffersByKey: { [key]: buffer },
      statusByProject: {},
      loadingByKey: {},
      errorsByKey: {},
      conflictsByKey: {},
    });
  });

  it("uses the buffer CAS after a realtime refresh advances global state", async () => {
    const advancedWorktree = {
      ...worktree,
      revision: 8,
      wipOid: "d".repeat(40),
      leaseEpoch: 4,
    };
    vi.spyOn(apiClient, "get").mockResolvedValue({
      success: true,
      worktree: advancedWorktree,
      clean: false,
      changes: [],
    });
    const put = vi.spyOn(apiClient, "putWithStatus").mockResolvedValue({
      status: 409,
      body: {
        success: false,
        error: "Stale worktree mutation state",
      },
    });

    await useAppV2Store
      .getState()
      .loadStatus("workspace-1", worktree.projectId);
    const result = await useAppV2Store
      .getState()
      .saveFile("workspace-1", worktree.projectId, file.path);

    expect(result).toBe("conflict");
    expect(put).toHaveBeenCalledWith(
      "/workspaces/workspace-1/apps-v2/project-1/worktrees/worktree-1/file",
      {
        ifRevision: 7,
        expectedWipOid: "b".repeat(40),
        leaseEpoch: 3,
        path: file.path,
        content: "local edits",
        executable: false,
      },
      { alsoOk: [409] },
    );
    const key = appV2FileKey(worktree.projectId, file.path);
    expect(useAppV2Store.getState().editorBuffersByKey[key]).toMatchObject({
      content: "local edits",
      dirty: true,
      baseRevision: 7,
      baseWipOid: "b".repeat(40),
      baseLeaseEpoch: 3,
      remoteUpdate: {
        revision: 8,
        wipOid: "d".repeat(40),
        leaseEpoch: 4,
      },
    });
    expect(useAppV2Store.getState().conflictsByKey[key]?.message).toBe(
      "Stale worktree mutation state",
    );
  });

  it("reloads pristine buffers after discard and preserves dirty buffers", async () => {
    const pristinePath = "src/pristine.ts";
    const dirtyKey = appV2FileKey(worktree.projectId, file.path);
    const pristineKey = appV2FileKey(worktree.projectId, pristinePath);
    useAppV2Store.setState(state => ({
      ...state,
      filesByKey: {
        ...state.filesByKey,
        [pristineKey]: { ...file, path: pristinePath, content: "before" },
      },
      editorBuffersByKey: {
        ...state.editorBuffersByKey,
        [pristineKey]: {
          ...buffer,
          path: pristinePath,
          content: "before",
          dirty: false,
        },
      },
    }));
    const discardedWorktree = {
      ...worktree,
      revision: 8,
      wipOid: "e".repeat(40),
    };
    vi.spyOn(apiClient, "postWithStatus").mockResolvedValue({
      status: 200,
      body: { success: true, worktree: discardedWorktree },
    });
    vi.spyOn(apiClient, "get").mockImplementation(async path => {
      if (path.endsWith("/tree")) {
        return { success: true, worktree: discardedWorktree, entries: [] };
      }
      if (path.endsWith("/status")) {
        return {
          success: true,
          worktree: discardedWorktree,
          clean: true,
          changes: [],
        };
      }
      return {
        success: true,
        worktree: discardedWorktree,
        path: pristinePath,
        oid: "f".repeat(40),
        mode: "regular",
        content: "after discard",
      };
    });

    expect(
      await useAppV2Store.getState().discard("workspace-1", worktree.projectId),
    ).toBe("saved");
    expect(
      useAppV2Store.getState().editorBuffersByKey[pristineKey],
    ).toMatchObject({
      content: "after discard",
      dirty: false,
      baseRevision: 8,
      remoteUpdate: null,
    });
    expect(useAppV2Store.getState().editorBuffersByKey[dirtyKey]).toMatchObject(
      {
        content: "local edits",
        dirty: true,
        baseRevision: 7,
        remoteUpdate: {
          revision: 8,
          wipOid: "e".repeat(40),
          leaseEpoch: 3,
        },
      },
    );
  });

  it("preserves a dirty buffer unless force-loading the remote version", async () => {
    const key = appV2FileKey(worktree.projectId, file.path);
    const get = vi.spyOn(apiClient, "get").mockResolvedValue({
      success: true,
      worktree: {
        ...worktree,
        revision: 8,
        wipOid: "f".repeat(40),
      },
      path: file.path,
      oid: "e".repeat(40),
      mode: "regular",
      content: "remote version",
    });

    await useAppV2Store
      .getState()
      .reloadFile("workspace-1", worktree.projectId, file.path);
    expect(get).not.toHaveBeenCalled();
    expect(useAppV2Store.getState().editorBuffersByKey[key]).toMatchObject({
      content: "local edits",
      dirty: true,
      baseRevision: 7,
      baseWipOid: "b".repeat(40),
    });

    await useAppV2Store
      .getState()
      .reloadFile("workspace-1", worktree.projectId, file.path, {
        discardDirty: true,
      });
    expect(get).toHaveBeenCalledTimes(1);
    expect(useAppV2Store.getState().editorBuffersByKey[key]).toMatchObject({
      content: "remote version",
      dirty: false,
      baseRevision: 8,
      baseWipOid: "f".repeat(40),
      remoteUpdate: null,
    });
  });

  it("automatically retries a transient status failure once", async () => {
    const get = vi
      .spyOn(apiClient, "get")
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({ enabled: true });

    expect(
      await useAppV2Store.getState().fetchStatusWithRetry("workspace-1"),
    ).toBe(true);
    expect(
      useAppV2Store.getState().availabilityByWorkspace["workspace-1"],
    ).toMatchObject({ loaded: true, enabled: true, error: null });
    expect(get).toHaveBeenCalledTimes(2);
  });
});
