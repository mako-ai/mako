// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const workspaceApi = vi.hoisted(() => ({
  listWorkspaces: vi.fn(),
  switchWorkspace: vi.fn(),
  createWorkspace: vi.fn(),
}));
vi.mock("./workspace/workspace-api", () => ({ workspaceApi }));

const workspaceIdSource = vi.hoisted(() => ({
  current: null as null | (() => string | null),
}));
vi.mock("../api/client", () => ({
  api: {},
  setWorkspaceIdSource: (source: () => string | null) => {
    workspaceIdSource.current = source;
  },
}));

import { getCurrentWorkspaceId, useWorkspaceStore } from "./workspaceStore";
import type { Workspace } from "./workspace/types";

const ws = (id: string) => ({ id, name: id }) as Workspace;
const KEY = "activeWorkspaceId";

beforeEach(() => {
  vi.clearAllMocks();
  workspaceApi.switchWorkspace.mockResolvedValue(undefined);
  sessionStorage.clear();
  localStorage.clear();
  useWorkspaceStore.setState({
    currentWorkspaceId: null,
    currentWorkspace: null,
    workspaces: [],
    initialized: false,
  });
});

describe("workspaceStore — the active workspace", () => {
  it("is what the API client sends as x-workspace-id", () => {
    useWorkspaceStore.setState({ currentWorkspaceId: "w1" });
    expect(workspaceIdSource.current?.()).toBe("w1");
    expect(getCurrentWorkspaceId()).toBe("w1");
  });

  it("auto-selects the only workspace and remembers it for this tab", async () => {
    workspaceApi.listWorkspaces.mockResolvedValue([ws("w1")]);
    await useWorkspaceStore.getState().loadWorkspaces();
    const s = useWorkspaceStore.getState();
    expect(s.currentWorkspace?.id).toBe("w1");
    expect(s.currentWorkspaceId).toBe("w1");
    expect(s.initialized).toBe(true);
    expect(sessionStorage.getItem(KEY)).toBe("w1");
    expect(workspaceApi.switchWorkspace).toHaveBeenCalledWith("w1");
  });

  it("restores this tab's choice over the cross-tab default", async () => {
    sessionStorage.setItem(KEY, "w2");
    localStorage.setItem(KEY, "w3"); // another tab switched to w3 since
    workspaceApi.listWorkspaces.mockResolvedValue([
      ws("w1"),
      ws("w2"),
      ws("w3"),
    ]);
    await useWorkspaceStore.getState().loadWorkspaces();
    expect(useWorkspaceStore.getState().currentWorkspaceId).toBe("w2");
  });

  it("falls back to the last choice in any tab for a fresh tab", async () => {
    localStorage.setItem(KEY, "w3");
    workspaceApi.listWorkspaces.mockResolvedValue([ws("w1"), ws("w3")]);
    await useWorkspaceStore.getState().loadWorkspaces();
    expect(useWorkspaceStore.getState().currentWorkspaceId).toBe("w3");
    // ...and pins it to this tab from then on.
    expect(sessionStorage.getItem(KEY)).toBe("w3");
  });

  it("selects nothing (the picker) when the remembered workspace is gone", async () => {
    sessionStorage.setItem(KEY, "gone");
    workspaceApi.listWorkspaces.mockResolvedValue([ws("w1"), ws("w2")]);
    await useWorkspaceStore.getState().loadWorkspaces();
    const s = useWorkspaceStore.getState();
    expect(s.currentWorkspace).toBeNull();
    expect(s.currentWorkspaceId).toBeNull();
    expect(sessionStorage.getItem(KEY)).toBeNull();
  });

  it("onboarding creation selects the new workspace without a reload", async () => {
    workspaceApi.createWorkspace.mockResolvedValue(ws("new"));
    await useWorkspaceStore
      .getState()
      .createWorkspaceForOnboarding({ name: "new" });
    expect(useWorkspaceStore.getState().currentWorkspaceId).toBe("new");
    expect(localStorage.getItem(KEY)).toBe("new");
  });

  it("clearSession drops data but keeps the hint for the next sign-in", async () => {
    workspaceApi.listWorkspaces.mockResolvedValue([ws("w1")]);
    await useWorkspaceStore.getState().loadWorkspaces();
    useWorkspaceStore.getState().clearSession();
    const s = useWorkspaceStore.getState();
    expect(s.currentWorkspace).toBeNull();
    expect(s.workspaces).toEqual([]);
    expect(s.initialized).toBe(false);
    expect(sessionStorage.getItem(KEY)).toBe("w1");
  });
});
