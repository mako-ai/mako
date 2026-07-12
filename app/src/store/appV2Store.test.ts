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
      sessionsByProject: {},
      sessionCommandsByProject: {},
      sessionFlushesByProject: {},
      sessionIssuesByProject: {},
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
        return {
          success: true,
          worktree: discardedWorktree,
          entries: [
            {
              path: pristinePath,
              oid: "f".repeat(40),
              size: 13,
              mode: "regular",
            },
          ],
        };
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

  it("refreshes clean buffers, removes deleted clean files, and preserves dirty buffers", async () => {
    const cleanPath = "src/clean.ts";
    const deletedPath = "src/deleted.ts";
    const dirtyKey = appV2FileKey(worktree.projectId, file.path);
    const cleanKey = appV2FileKey(worktree.projectId, cleanPath);
    const deletedKey = appV2FileKey(worktree.projectId, deletedPath);
    useAppV2Store.setState(state => ({
      ...state,
      projectsById: {
        [worktree.projectId]: {
          id: worktree.projectId,
          workspaceId: "workspace-1",
          title: "Project",
        } as never,
      },
      filesByKey: {
        ...state.filesByKey,
        [cleanKey]: { ...file, path: cleanPath, content: "clean before" },
        [deletedKey]: { ...file, path: deletedPath, content: "deleted before" },
      },
      editorBuffersByKey: {
        ...state.editorBuffersByKey,
        [cleanKey]: {
          ...buffer,
          path: cleanPath,
          content: "clean before",
          dirty: false,
        },
        [deletedKey]: {
          ...buffer,
          path: deletedPath,
          content: "deleted before",
          dirty: false,
        },
      },
    }));
    const advancedWorktree = {
      ...worktree,
      revision: 8,
      wipOid: "d".repeat(40),
      leaseEpoch: 4,
    };
    vi.spyOn(apiClient, "get").mockImplementation(async (path, query) => {
      if (path.endsWith("/apps-v2/project-1")) {
        return {
          success: true,
          project: useAppV2Store.getState().projectsById[worktree.projectId],
        };
      }
      if (path.endsWith("/tree")) {
        return {
          success: true,
          worktree: advancedWorktree,
          entries: [
            {
              path: cleanPath,
              oid: "e".repeat(40),
              size: 11,
              mode: "regular",
            },
            {
              path: file.path,
              oid: file.oid,
              size: file.content.length,
              mode: "regular",
            },
          ],
        };
      }
      if (path.endsWith("/status")) {
        return {
          success: true,
          worktree: advancedWorktree,
          clean: false,
          changes: [],
        };
      }
      expect(query).toEqual({ path: cleanPath });
      return {
        success: true,
        worktree: advancedWorktree,
        path: cleanPath,
        oid: "e".repeat(40),
        mode: "regular",
        content: "clean after",
      };
    });

    await useAppV2Store
      .getState()
      .refreshProject("workspace-1", worktree.projectId);

    expect(useAppV2Store.getState().editorBuffersByKey[cleanKey]).toMatchObject(
      {
        content: "clean after",
        dirty: false,
        baseRevision: 8,
        baseWipOid: "d".repeat(40),
        baseLeaseEpoch: 4,
        remoteUpdate: null,
      },
    );
    expect(
      useAppV2Store.getState().editorBuffersByKey[deletedKey],
    ).toBeUndefined();
    expect(useAppV2Store.getState().filesByKey[deletedKey]).toBeUndefined();
    expect(
      useAppV2Store.getState().errorsByKey[`file:${deletedKey}`],
    ).toContain("no longer exists");
    expect(useAppV2Store.getState().editorBuffersByKey[dirtyKey]).toMatchObject(
      {
        content: "local edits",
        dirty: true,
        baseRevision: 7,
        remoteUpdate: {
          revision: 8,
          wipOid: "d".repeat(40),
          leaseEpoch: 4,
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
      .mockResolvedValueOnce({
        enabled: true,
        sandboxAvailable: true,
        sandboxProvider: "e2b",
      });

    expect(
      await useAppV2Store.getState().fetchStatusWithRetry("workspace-1"),
    ).toBe(true);
    expect(
      useAppV2Store.getState().availabilityByWorkspace["workspace-1"],
    ).toMatchObject({
      loaded: true,
      enabled: true,
      sandboxAvailable: true,
      sandboxProvider: "e2b",
      error: null,
    });
    expect(get).toHaveBeenCalledTimes(2);
  });

  it("refreshes only loaded projects in the active workspace", async () => {
    const refreshProject = vi.fn(async () => undefined);
    useAppV2Store.setState(state => ({
      ...state,
      projectsById: {
        "project-1": {
          id: "project-1",
          workspaceId: "workspace-1",
        } as never,
        "project-2": {
          id: "project-2",
          workspaceId: "workspace-2",
        } as never,
        "project-not-loaded": {
          id: "project-not-loaded",
          workspaceId: "workspace-1",
        } as never,
      },
      worktreesByProject: {
        "project-1": worktree,
        "project-2": { ...worktree, projectId: "project-2" },
      },
      refreshProject,
    }));

    await useAppV2Store.getState().refreshLoadedProjects("workspace-1");

    expect(refreshProject).toHaveBeenCalledOnce();
    expect(refreshProject).toHaveBeenCalledWith("workspace-1", "project-1");
  });
});

describe("appV2Store sandbox session API", () => {
  const session = {
    worktreeId: worktree.id,
    provider: "e2b",
    sandboxId: "sandbox-1",
    generation: 1,
    leaseEpoch: worktree.leaseEpoch,
    appliedWipOid: worktree.wipOid,
    status: "active" as const,
    lastActiveAt: "2026-01-01T00:00:00.000Z",
  };

  beforeEach(() => {
    vi.restoreAllMocks();
    useAppV2Store.setState({
      availabilityByWorkspace: {
        "workspace-1": {
          enabled: true,
          sandboxAvailable: true,
          sandboxProvider: "e2b",
          loaded: true,
          loading: false,
          error: null,
        },
      },
      projectsByWorkspace: {},
      projectsById: {},
      worktreesByProject: { [worktree.projectId]: worktree },
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
    });
  });

  it("gates session creation when the provider is unavailable", async () => {
    useAppV2Store.setState(state => ({
      availabilityByWorkspace: {
        ...state.availabilityByWorkspace,
        "workspace-1": {
          ...state.availabilityByWorkspace["workspace-1"],
          sandboxAvailable: false,
          sandboxProvider: "off",
        },
      },
    }));
    const post = vi.spyOn(apiClient, "postWithStatus");

    expect(
      await useAppV2Store
        .getState()
        .ensureSession("workspace-1", worktree.projectId),
    ).toBeNull();
    expect(post).not.toHaveBeenCalled();
    expect(
      useAppV2Store.getState().sessionIssuesByProject[worktree.projectId],
    ).toMatchObject({ kind: "provider_unavailable" });
  });

  it("ensures and reads the actor session through apiClient", async () => {
    const post = vi.spyOn(apiClient, "postWithStatus").mockResolvedValue({
      status: 200,
      body: { success: true, session, worktree },
    });
    const get = vi.spyOn(apiClient, "getWithStatus").mockResolvedValue({
      status: 200,
      body: { success: true, session },
    });

    expect(
      await useAppV2Store
        .getState()
        .ensureSession("workspace-1", worktree.projectId),
    ).toEqual(session);
    expect(post).toHaveBeenCalledWith(
      "/workspaces/workspace-1/apps-v2/project-1/session",
      undefined,
      { alsoOk: [409, 503] },
    );
    expect(
      await useAppV2Store
        .getState()
        .getSession("workspace-1", worktree.projectId),
    ).toEqual(session);
    expect(get).toHaveBeenCalledWith(
      "/workspaces/workspace-1/apps-v2/project-1/session",
      { alsoOk: [404, 409, 503] },
    );
  });

  it("sends finite argv and surfaces command output and durability", async () => {
    const result = {
      exitCode: 7,
      stdout: "stdout",
      stderr: "stderr",
      timedOut: false,
      cancelled: false,
      outputTruncated: false,
      excludedPaths: ["node_modules"],
      durability: {
        status: "durable" as const,
        revision: { wipOid: "d".repeat(40), revision: 8 },
      },
    };
    const post = vi.spyOn(apiClient, "postWithStatus").mockResolvedValue({
      status: 200,
      body: { success: true, result },
    });
    vi.spyOn(apiClient, "get").mockImplementation(async path => {
      if (path.endsWith("/worktree")) {
        return { success: true, worktree: { ...worktree, revision: 8 } };
      }
      if (path.endsWith("/tree")) {
        return { success: true, worktree, entries: [] };
      }
      return { success: true, worktree, clean: false, changes: [] };
    });
    const argv = ["printf", "%s", "$(touch /tmp/not-run)", "semi;colon"];

    expect(
      await useAppV2Store
        .getState()
        .execSession("workspace-1", worktree.projectId, argv),
    ).toEqual({ ...result, operation: "exec" });
    expect(post).toHaveBeenCalledWith(
      "/workspaces/workspace-1/apps-v2/project-1/session/exec",
      { argv, cwd: "" },
      { alsoOk: [409, 503] },
    );
    expect(
      useAppV2Store.getState().sessionCommandsByProject[worktree.projectId],
    ).toMatchObject({
      stdout: "stdout",
      stderr: "stderr",
      excludedPaths: ["node_modules"],
      operation: "exec",
    });
  });

  it("installs package specs and preserves recovery conflict details", async () => {
    const recoveryRef = "refs/mako/recovery/worktree-1/install";
    const result = {
      exitCode: 0,
      stdout: "installed",
      stderr: "",
      timedOut: false,
      cancelled: false,
      outputTruncated: false,
      excludedPaths: ["node_modules"],
      durability: { status: "conflict" as const, recoveryRef },
    };
    const post = vi.spyOn(apiClient, "postWithStatus").mockResolvedValue({
      status: 409,
      body: {
        success: false,
        error: "Install flush conflicted",
        result,
      },
    });
    const packages = ["react@18.3.1", "@scope/pkg@latest"];

    expect(
      await useAppV2Store
        .getState()
        .installPackages("workspace-1", worktree.projectId, packages),
    ).toEqual({ ...result, operation: "install" });
    expect(post).toHaveBeenCalledWith(
      "/workspaces/workspace-1/apps-v2/project-1/session/install",
      { packages },
      { alsoOk: [409, 503] },
    );
    expect(
      useAppV2Store.getState().sessionIssuesByProject[worktree.projectId],
    ).toMatchObject({
      kind: "conflict",
      recoveryRef,
    });
  });

  it("flushes, pauses, and destroys through finite lifecycle endpoints", async () => {
    const flush = {
      excludedPaths: [".env.local"],
      durability: {
        status: "durable" as const,
        revision: { wipOid: worktree.wipOid, revision: worktree.revision },
      },
    };
    const post = vi.spyOn(apiClient, "postWithStatus").mockResolvedValue({
      status: 200,
      body: { success: true, session, flush },
    });
    const remove = vi.spyOn(apiClient, "deleteWithStatus").mockResolvedValue({
      status: 200,
      body: {
        success: true,
        session: { ...session, status: "destroyed" },
        flush,
      },
    });

    await useAppV2Store
      .getState()
      .flushSession("workspace-1", worktree.projectId);
    await useAppV2Store
      .getState()
      .pauseSession("workspace-1", worktree.projectId);
    await useAppV2Store
      .getState()
      .destroySession("workspace-1", worktree.projectId);

    expect(post.mock.calls.map(call => call[0])).toEqual([
      "/workspaces/workspace-1/apps-v2/project-1/session/flush",
      "/workspaces/workspace-1/apps-v2/project-1/session/pause",
    ]);
    expect(remove).toHaveBeenCalledWith(
      "/workspaces/workspace-1/apps-v2/project-1/session",
      { alsoOk: [409, 503] },
    );
    expect(
      useAppV2Store.getState().sessionFlushesByProject[worktree.projectId],
    ).toEqual(flush);
  });
});
