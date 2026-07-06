import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the typed API client the store depends on. Each method is a vi.fn we
// configure per test; the store treats the resolved value as the parsed body.
vi.mock("../lib/api-client", () => ({
  apiClient: {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
  },
}));

import { apiClient } from "../lib/api-client";
import { useDbtStore } from "./dbtStore";

const api = apiClient as unknown as {
  get: ReturnType<typeof vi.fn>;
  post: ReturnType<typeof vi.fn>;
  patch: ReturnType<typeof vi.fn>;
  put: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
};

const WS = "ws1";

function project(id: string, name = id) {
  return {
    _id: id,
    name,
    dbtVersion: "1.9",
    environments: [],
    defaultEnvironment: "dev",
  };
}

beforeEach(() => {
  useDbtStore.getState().reset();
  vi.clearAllMocks();
});

describe("fetchProjects — active selection", () => {
  it("defaults activeProjectId to the first project", async () => {
    api.get.mockResolvedValue({
      success: true,
      projects: [project("p1"), project("p2")],
    });
    await useDbtStore.getState().fetchProjects(WS);
    const s = useDbtStore.getState();
    expect(s.projects).toHaveLength(2);
    expect(s.projectsLoaded).toBe(true);
    expect(s.activeProjectId).toBe("p1");
  });

  it("preserves a still-valid active selection across refetch", async () => {
    api.get.mockResolvedValue({
      success: true,
      projects: [project("p1"), project("p2")],
    });
    await useDbtStore.getState().fetchProjects(WS);
    useDbtStore.getState().setActiveProject("p2");
    await useDbtStore.getState().fetchProjects(WS);
    expect(useDbtStore.getState().activeProjectId).toBe("p2");
  });

  it("reassigns active when the selected project disappears", async () => {
    api.get.mockResolvedValueOnce({
      success: true,
      projects: [project("p1"), project("p2")],
    });
    await useDbtStore.getState().fetchProjects(WS);
    useDbtStore.getState().setActiveProject("p2");
    api.get.mockResolvedValueOnce({ success: true, projects: [project("p1")] });
    await useDbtStore.getState().fetchProjects(WS);
    expect(useDbtStore.getState().activeProjectId).toBe("p1");
  });

  it("records an error and does not throw on failure", async () => {
    api.get.mockRejectedValue(new Error("boom"));
    await useDbtStore.getState().fetchProjects(WS);
    const s = useDbtStore.getState();
    expect(s.error.projects).toMatch(/boom/);
    expect(s.loading.projects).toBe(false);
  });
});

describe("createProject / deleteProject — active bookkeeping", () => {
  it("prepends the new project and selects it", async () => {
    api.get.mockResolvedValue({ success: true, projects: [project("p1")] });
    await useDbtStore.getState().fetchProjects(WS);
    api.post.mockResolvedValue({ success: true, project: project("p2") });
    const created = await useDbtStore.getState().createProject(WS, {
      name: "p2",
    } as never);
    expect(created?._id).toBe("p2");
    const s = useDbtStore.getState();
    expect(s.projects[0]._id).toBe("p2");
    expect(s.activeProjectId).toBe("p2");
  });

  it("reassigns active to the next project after deleting the active one", async () => {
    api.get.mockResolvedValue({
      success: true,
      projects: [project("p1"), project("p2")],
    });
    await useDbtStore.getState().fetchProjects(WS);
    useDbtStore.getState().setActiveProject("p1");
    api.delete.mockResolvedValue({ success: true });
    await useDbtStore.getState().deleteProject(WS, "p1");
    const s = useDbtStore.getState();
    expect(s.projects.map(p => p._id)).toEqual(["p2"]);
    expect(s.activeProjectId).toBe("p2");
  });

  it("clears active when the last project is deleted", async () => {
    api.get.mockResolvedValue({ success: true, projects: [project("p1")] });
    await useDbtStore.getState().fetchProjects(WS);
    api.delete.mockResolvedValue({ success: true });
    await useDbtStore.getState().deleteProject(WS, "p1");
    expect(useDbtStore.getState().activeProjectId).toBeNull();
  });
});

describe("file buffer — write / persist / read", () => {
  it("writeFile marks the buffer dirty and registers the path", () => {
    useDbtStore.getState().writeFile("p1", "models/a.sql", "select 1");
    const s = useDbtStore.getState();
    expect(s.filesByProject.p1["models/a.sql"]).toEqual({
      content: "select 1",
      dirty: true,
      loaded: true,
    });
  });

  it("persistFile PUTs the content and clears the dirty flag", async () => {
    useDbtStore.getState().writeFile("p1", "models/a.sql", "select 1");
    api.put.mockResolvedValue({ success: true });
    const ok = await useDbtStore
      .getState()
      .persistFile(WS, "p1", "models/a.sql");
    expect(ok).toBe(true);
    expect(api.put).toHaveBeenCalledWith(
      `/workspaces/${WS}/dbt/projects/p1/files/models/a.sql`,
      // clientId (per-tab echo suppression) rides along with every save.
      { content: "select 1", clientId: expect.any(String) },
    );
    expect(useDbtStore.getState().filesByProject.p1["models/a.sql"].dirty).toBe(
      false,
    );
  });

  it("readFile caches and short-circuits the second call", async () => {
    api.get.mockResolvedValue({
      success: true,
      file: { path: "models/a.sql", content: "select 2" },
    });
    const first = await useDbtStore
      .getState()
      .readFile(WS, "p1", "models/a.sql");
    expect(first).toBe("select 2");
    const second = await useDbtStore
      .getState()
      .readFile(WS, "p1", "models/a.sql");
    expect(second).toBe("select 2");
    expect(api.get).toHaveBeenCalledTimes(1); // served from cache the 2nd time
  });
});

describe("ad-hoc runner passthrough", () => {
  it("compileModel posts conditional body and returns the compile result", async () => {
    api.post.mockResolvedValue({
      success: true,
      compile: { ok: true, exitCode: 0, compiledSql: "select 1", logs: [] },
    });
    const res = await useDbtStore
      .getState()
      .compileModel(WS, "p1", "customers", "dev", true);
    expect(res?.compiledSql).toBe("select 1");
    expect(api.post).toHaveBeenCalledWith(
      `/workspaces/${WS}/dbt/projects/p1/compile`,
      { select: "customers", environment: "dev", defer: true },
    );
  });

  it("compileModel returns a synthetic error result on failure (never throws)", async () => {
    api.post.mockRejectedValue(new Error("network down"));
    const res = await useDbtStore
      .getState()
      .compileModel(WS, "p1", "customers");
    expect(res?.ok).toBe(false);
    expect(res?.logs[0].line).toMatch(/network down/);
  });

  it("runCommand posts the raw command and returns the result", async () => {
    api.post.mockResolvedValue({
      success: true,
      result: {
        ok: true,
        exitCode: 0,
        subcommand: "build",
        stepResults: [],
        logs: [],
      },
    });
    const res = await useDbtStore
      .getState()
      .runCommand(WS, "p1", "build --select customers+", "dev");
    expect(res?.ok).toBe(true);
    expect(api.post).toHaveBeenCalledWith(
      `/workspaces/${WS}/dbt/projects/p1/command`,
      { command: "build --select customers+", environment: "dev" },
    );
  });

  it("fetchLineage returns the lineage payload", async () => {
    api.get.mockResolvedValue({
      success: true,
      lineage: { nodes: [{ id: "model.x" }], edges: [] },
    });
    const res = await useDbtStore.getState().fetchLineage(WS, "p1");
    expect(res?.nodes).toHaveLength(1);
  });
});

describe("project update + file list/delete/rename", () => {
  it("updateProject replaces the project in place", async () => {
    api.get.mockResolvedValue({
      success: true,
      projects: [project("p1", "Old")],
    });
    await useDbtStore.getState().fetchProjects(WS);
    api.patch.mockResolvedValue({
      success: true,
      project: { ...project("p1", "New") },
    });
    const res = await useDbtStore
      .getState()
      .updateProject(WS, "p1", { name: "New" });
    expect(res?.name).toBe("New");
    expect(useDbtStore.getState().projects[0].name).toBe("New");
  });

  it("fetchFiles stores the path list", async () => {
    api.get.mockResolvedValue({
      success: true,
      files: [{ path: "models/a.sql" }, { path: "models/b.sql" }],
    });
    await useDbtStore.getState().fetchFiles(WS, "p1");
    expect(useDbtStore.getState().filePathsByProject.p1).toEqual([
      "models/a.sql",
      "models/b.sql",
    ]);
  });

  it("deleteFile removes the buffer and path", async () => {
    useDbtStore.getState().writeFile("p1", "models/a.sql", "x");
    api.delete.mockResolvedValue({ success: true });
    const ok = await useDbtStore
      .getState()
      .deleteFile(WS, "p1", "models/a.sql");
    expect(ok).toBe(true);
    expect(
      useDbtStore.getState().filesByProject.p1?.["models/a.sql"],
    ).toBeUndefined();
  });

  it("renameFile moves the buffer and rewrites the path list", async () => {
    api.get.mockResolvedValue({
      success: true,
      files: [{ path: "models/a.sql" }],
    });
    await useDbtStore.getState().fetchFiles(WS, "p1");
    useDbtStore.getState().writeFile("p1", "models/a.sql", "x");
    api.post.mockResolvedValue({ success: true });
    const ok = await useDbtStore
      .getState()
      .renameFile(WS, "p1", "models/a.sql", "models/b.sql");
    expect(ok).toBe(true);
    const files = useDbtStore.getState().filesByProject.p1;
    expect(files["models/a.sql"]).toBeUndefined();
    expect(files["models/b.sql"].content).toBe("x");
    expect(useDbtStore.getState().filePathsByProject.p1).toContain(
      "models/b.sql",
    );
    expect(api.post).toHaveBeenCalledWith(
      `/workspaces/${WS}/dbt/projects/p1/files/rename`,
      // clientId (per-tab echo suppression) rides along with every rename.
      {
        from: "models/a.sql",
        to: "models/b.sql",
        clientId: expect.any(String),
      },
    );
  });
});

describe("jobs", () => {
  it("fetchJobs stores jobs per project", async () => {
    api.get.mockResolvedValue({
      success: true,
      jobs: [{ _id: "j1", name: "nightly" }],
    });
    await useDbtStore.getState().fetchJobs(WS, "p1");
    expect(useDbtStore.getState().jobsByProject.p1).toHaveLength(1);
  });

  it("saveJob POSTs a new job and PATCHes an existing one", async () => {
    api.post.mockResolvedValue({
      success: true,
      job: { _id: "j1", name: "a" },
    });
    await useDbtStore.getState().saveJob(WS, "p1", { name: "a" } as never);
    expect(api.post).toHaveBeenCalled();
    expect(useDbtStore.getState().jobsByProject.p1[0]._id).toBe("j1");

    api.patch.mockResolvedValue({
      success: true,
      job: { _id: "j1", name: "b" },
    });
    await useDbtStore
      .getState()
      .saveJob(WS, "p1", { name: "b" } as never, "j1");
    expect(api.patch).toHaveBeenCalledWith(
      `/workspaces/${WS}/dbt/projects/p1/jobs/j1`,
      { name: "b" },
    );
    expect(useDbtStore.getState().jobsByProject.p1[0].name).toBe("b");
  });

  it("deleteJob removes the job", async () => {
    api.get.mockResolvedValue({
      success: true,
      jobs: [{ _id: "j1", name: "a" }],
    });
    await useDbtStore.getState().fetchJobs(WS, "p1");
    api.delete.mockResolvedValue({ success: true });
    await useDbtStore.getState().deleteJob(WS, "p1", "j1");
    expect(useDbtStore.getState().jobsByProject.p1).toHaveLength(0);
  });

  it("triggerJob returns the runId and refreshes runs", async () => {
    api.post.mockResolvedValue({ success: true, runId: "r9" });
    api.get.mockResolvedValue({ success: true, runs: [] });
    const runId = await useDbtStore.getState().triggerJob(WS, "p1", "j1");
    expect(runId).toBe("r9");
    expect(api.get).toHaveBeenCalled(); // fetchRuns side-effect
  });
});

describe("runs lifecycle", () => {
  it("fetchRuns stores runs and forwards jobId as a query", async () => {
    api.get.mockResolvedValue({
      success: true,
      runs: [{ _id: "r1", status: "success" }],
    });
    await useDbtStore.getState().fetchRuns(WS, "p1", "j1");
    // Job-scoped fetches land in runsByJob (runsByProject is the unfiltered
    // project-wide list — the two views never clobber each other).
    expect(useDbtStore.getState().runsByJob.j1).toHaveLength(1);
    expect(useDbtStore.getState().runsByProject.p1).toBeUndefined();
    expect(api.get).toHaveBeenCalledWith(
      `/workspaces/${WS}/dbt/projects/p1/runs`,
      { jobId: "j1", limit: "100" },
    );
  });

  it("fetchRunDetails appends incremental logs across calls", async () => {
    api.get.mockResolvedValueOnce({
      success: true,
      run: { _id: "r1", status: "running", logs: ["a"], logCursor: 1 },
    });
    await useDbtStore.getState().fetchRunDetails(WS, "p1", "r1");
    api.get.mockResolvedValueOnce({
      success: true,
      run: { _id: "r1", status: "success", logs: ["b"], logCursor: 2 },
    });
    const merged = await useDbtStore.getState().fetchRunDetails(WS, "p1", "r1");
    expect(merged?.logs).toEqual(["a", "b"]);
    expect(merged?.status).toBe("success");
  });

  it("cancelRun POSTs and resolves true", async () => {
    api.post.mockResolvedValue({ success: true });
    const ok = await useDbtStore.getState().cancelRun(WS, "p1", "r1");
    expect(ok).toBe(true);
    expect(api.post).toHaveBeenCalledWith(
      `/workspaces/${WS}/dbt/projects/p1/runs/r1/cancel`,
    );
  });

  it("retryRun returns the new runId and refreshes runs", async () => {
    api.post.mockResolvedValue({ success: true, runId: "r2" });
    api.get.mockResolvedValue({ success: true, runs: [] });
    const runId = await useDbtStore.getState().retryRun(WS, "p1", "r1", "j1");
    expect(runId).toBe("r2");
  });
});

describe("git / github actions", () => {
  it("syncProjectFromGitHub merges the project and clears the file cache", async () => {
    api.get.mockResolvedValue({ success: true, projects: [project("p1")] });
    await useDbtStore.getState().fetchProjects(WS);
    useDbtStore.getState().writeFile("p1", "models/a.sql", "stale");
    api.post.mockResolvedValue({
      success: true,
      project: project("p1", "Synced"),
      sha: "abc",
      added: 1,
      updated: 0,
      deleted: 0,
    });
    const res = await useDbtStore.getState().syncProjectFromGitHub(WS, "p1");
    expect(res?.sha).toBe("abc");
    expect(useDbtStore.getState().projects[0].name).toBe("Synced");
    expect(useDbtStore.getState().filesByProject.p1).toBeUndefined();
  });

  it("fetchGitStatus caches the status per project", async () => {
    api.get.mockResolvedValue({
      success: true,
      status: { branch: "main", dirty: false, files: [] },
    });
    const status = await useDbtStore.getState().fetchGitStatus(WS, "p1");
    expect(status?.branch).toBe("main");
    expect(useDbtStore.getState().gitStatusByProject.p1.branch).toBe("main");
  });

  it("switchBranch records the checkout branch and drops cached files", async () => {
    api.get.mockResolvedValue({ success: true, projects: [project("p1")] });
    await useDbtStore.getState().fetchProjects(WS);
    useDbtStore.getState().writeFile("p1", "models/a.sql", "stale");
    api.post.mockResolvedValue({
      success: true,
      branch: "feature",
      project: project("p1"),
    });
    await useDbtStore.getState().switchBranch(WS, "p1", "feature");
    expect(useDbtStore.getState().filesByProject.p1).toBeUndefined();
    expect(useDbtStore.getState().checkoutBranchByProject.p1).toBe("feature");
  });

  it("reconcileRemoteGitState refetches status only for loaded repo projects", async () => {
    api.get.mockResolvedValueOnce({
      success: true,
      projects: [
        { ...project("p1"), repo: { owner: "o", repo: "r", branch: "main" } },
        { ...project("p2"), repo: { owner: "o", repo: "r2", branch: "main" } },
        project("p3"), // blank project — no git surface
      ],
    });
    await useDbtStore.getState().fetchProjects(WS);
    // Only p1 has pulled git state in this window.
    api.get.mockResolvedValueOnce({
      success: true,
      status: { branch: "main", changes: [], hasChanges: false },
    });
    await useDbtStore.getState().fetchGitStatus(WS, "p1");
    api.get.mockClear();

    api.get.mockResolvedValue({
      success: true,
      status: {
        branch: "main",
        changes: [{ path: "models/a.sql", status: "modified" }],
        hasChanges: true,
      },
    });
    await useDbtStore.getState().reconcileRemoteGitState(WS);
    expect(api.get).toHaveBeenCalledTimes(1);
    expect(api.get).toHaveBeenCalledWith(
      `/workspaces/${WS}/dbt/projects/p1/git/status`,
    );
    expect(useDbtStore.getState().gitStatusByProject.p1.changes).toHaveLength(
      1,
    );
  });

  it("reconcileRemoteGitState reloads the tree when the branch moved", async () => {
    api.get.mockResolvedValueOnce({
      success: true,
      projects: [
        { ...project("p1"), repo: { owner: "o", repo: "r", branch: "main" } },
      ],
    });
    await useDbtStore.getState().fetchProjects(WS);
    api.get.mockResolvedValueOnce({
      success: true,
      status: { branch: "main", changes: [], hasChanges: false },
    });
    await useDbtStore.getState().fetchGitStatus(WS, "p1");
    useDbtStore.getState().writeFile("p1", "models/a.sql", "old branch");
    api.get.mockClear();

    // The server says the checkout now points at "feature" (missed poke).
    api.get.mockImplementation(async (url: string) => {
      if (url.endsWith("/git/status")) {
        return {
          success: true,
          status: { branch: "feature", changes: [], hasChanges: false },
        };
      }
      return { success: true, files: [{ path: "models/b.sql" }] };
    });
    await useDbtStore.getState().reconcileRemoteGitState(WS);
    const s = useDbtStore.getState();
    expect(s.checkoutBranchByProject.p1).toBe("feature");
    // Stale old-branch buffers were dropped and the tree reloaded.
    expect(s.filesByProject.p1).toBeUndefined();
    expect(s.filePathsByProject.p1).toEqual(["models/b.sql"]);
  });

  it("openPullRequest returns the PR number + url", async () => {
    api.post.mockResolvedValue({
      success: true,
      number: 7,
      htmlUrl: "https://github.com/x/y/pull/7",
    });
    const pr = await useDbtStore
      .getState()
      .openPullRequest(WS, "p1", { title: "t", body: "b" } as never);
    expect(pr).toEqual({ number: 7, htmlUrl: "https://github.com/x/y/pull/7" });
  });
});
