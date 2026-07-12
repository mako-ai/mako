// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { useAppV2Store, type AppV2Project } from "../store/appV2Store";
import AppV2GitHubSection from "./AppV2GitHubSection";

const project = {
  id: "project-1",
  workspaceId: "workspace-1",
  title: "App",
  description: undefined,
  access: "private",
  workspaceRole: "viewer",
  sharedWith: [],
  ownerId: "owner",
  effectiveRole: "owner",
  readOnly: false,
  repositoryProvider: "mako-git",
  repositoryId: "project-1",
  defaultBranch: "main",
  headSha: "a".repeat(40),
  githubPushAvailable: true,
  githubCanManage: true,
  github: {
    installationId: 42,
    owner: "mako",
    repo: "app",
    baseBranch: "main",
    autoPushOnTurnEnd: true,
    generation: 1,
    boundAt: "2026-01-01T00:00:00.000Z",
    boundBy: "owner",
  },
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
} satisfies AppV2Project;
const branches = [
  {
    chatId: "chat-1",
    branch: "mako/chat/chat-1",
    baseSha: "a".repeat(40),
    wipOid: "b".repeat(40),
    lastCommitSha: "c".repeat(40),
    status: "conflict",
    remote: {
      branch: "mako/chat/chat-1",
      status: "conflict" as const,
      error: "advanced",
    },
  },
  {
    chatId: "chat-2",
    branch: "mako/chat/chat-2",
    baseSha: "a".repeat(40),
    wipOid: "d".repeat(40),
    lastCommitSha: "e".repeat(40),
    status: "clean",
  },
];

beforeEach(() => {
  vi.restoreAllMocks();
  useAppV2Store.setState({
    errorsByKey: {},
    fetchGitHubStatus: vi.fn(async () => ({
      appConfigured: true,
      installations: [
        {
          installationId: 42,
          accountLogin: "mako",
          accountType: "Organization" as const,
        },
      ],
    })),
    fetchGitHubRepos: vi.fn(async () => [
      {
        owner: "mako",
        name: "app",
        fullName: "mako/app",
        defaultBranch: "main",
        private: true,
      },
    ]),
    fetchGitHubBranches: vi.fn(async () => ["main"]),
    bindGitHub: vi.fn(async () => project),
    unbindGitHub: vi.fn(async () => project),
    pushGitHubConversation: vi.fn(async () => true),
  });
});

afterEach(() => cleanup());

describe("AppV2GitHubSection", () => {
  it("shows binding and conflict state without mutation controls to read-only users", () => {
    render(
      <AppV2GitHubSection
        workspaceId="workspace-1"
        project={{ ...project, readOnly: true, githubCanManage: false }}
        branches={branches}
      />,
    );

    expect(screen.getByText("mako/app · main")).toBeTruthy();
    expect(screen.getByText("conflict")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Unbind" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Push" })).toBeNull();
  });

  it("uses existing installation/repository discovery and exposes mirror controls", async () => {
    render(
      <AppV2GitHubSection
        workspaceId="workspace-1"
        project={project}
        branches={branches}
      />,
    );

    await waitFor(() =>
      expect(useAppV2Store.getState().fetchGitHubRepos).toHaveBeenCalledWith(
        "workspace-1",
        42,
      ),
    );
    expect(screen.getByText("Push automatically after each turn")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Update binding" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Unbind" })).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Push" })).toHaveLength(2);
    expect(screen.getByText("local only")).toBeTruthy();
    expect(screen.queryByText(/create repository/i)).toBeNull();
  });

  it("allows writable editors to push without exposing binding controls", () => {
    render(
      <AppV2GitHubSection
        workspaceId="workspace-1"
        project={{
          ...project,
          effectiveRole: "editor",
          githubCanManage: false,
        }}
        branches={branches}
      />,
    );

    expect(screen.getAllByRole("button", { name: "Push" })).toHaveLength(2);
    expect(screen.queryByRole("button", { name: "Unbind" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Update binding" })).toBeNull();
  });

  it("aggregates discovery and push errors and disables exact in-flight actions", async () => {
    useAppV2Store.setState({
      errorsByKey: {
        "github-status:workspace-1": "Installations unavailable",
        "github-push:project-1:chat-1": "Push failed",
      },
      loadingByKey: {
        "github-binding:project-1": true,
        "github-push:project-1:chat-1": true,
      },
    });
    render(
      <AppV2GitHubSection
        workspaceId="workspace-1"
        project={project}
        branches={branches}
      />,
    );

    expect(screen.getByRole("alert").textContent).toContain(
      "Installations unavailable",
    );
    expect(screen.getByRole("alert").textContent).toContain("Push failed");
    expect(
      screen
        .getByRole("button", { name: "Update binding" })
        .hasAttribute("disabled"),
    ).toBe(true);
    expect(
      screen.getByRole("button", { name: "Unbind" }).hasAttribute("disabled"),
    ).toBe(true);
    const pushButtons = screen.getAllByRole("button", { name: "Push" });
    expect(pushButtons[0].hasAttribute("disabled")).toBe(true);
    expect(pushButtons[1].hasAttribute("disabled")).toBe(false);
  });
});
