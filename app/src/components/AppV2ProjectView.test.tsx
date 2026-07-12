// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  useAppV2Store,
  type AppV2ConversationBranch,
  type AppV2Project,
} from "../store/appV2Store";
import { selectAppV2ConversationBranches } from "../apps-v2-runtime/selectors";
import { AppV2ConversationBranchesPanel } from "./AppV2ProjectView";

const project: AppV2Project = {
  id: "project-1",
  workspaceId: "workspace-1",
  title: "App",
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
  githubPushAvailable: false,
  githubCanManage: false,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const branch: AppV2ConversationBranch = {
  chatId: "64b7f0f0f0f0f0f0f0f0f0f0",
  branch: "mako/chat/64b7f0f0f0f0f0f0f0f0f0f0",
  baseSha: "a".repeat(40),
  wipOid: "b".repeat(40),
  lastCommitSha: "b".repeat(40),
  headSha: "b".repeat(40),
  aheadBy: 1,
  behindBy: 0,
  dirty: false,
  lastCommit: {
    sha: "b".repeat(40),
    authorName: "Mako Agent",
    authoredAt: "2026-01-01T00:00:00.000Z",
    message: "Agent turn",
  },
  status: "active",
};

describe("selectAppV2ConversationBranches", () => {
  it("returns a stable empty snapshot while branches are loading", () => {
    const state = { conversationBranchesByProject: {} };

    expect(selectAppV2ConversationBranches(state, project.id)).toBe(
      selectAppV2ConversationBranches(state, project.id),
    );
  });
});

describe("AppV2ConversationBranchesPanel", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    useAppV2Store.setState({
      loadingByKey: {},
      errorsByKey: {},
      conflictsByKey: {},
    });
  });

  afterEach(cleanup);

  it("confirms and reports a successful merge", async () => {
    const merge = vi.fn(async () => "saved" as const);
    useAppV2Store.setState({ mergeConversationBranch: merge });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    render(
      <AppV2ConversationBranchesPanel
        workspaceId="workspace-1"
        project={project}
        branches={[branch]}
      />,
    );

    await userEvent.click(
      screen.getByRole("button", { name: "Merge into main" }),
    );

    expect(confirm).toHaveBeenCalledWith(
      expect.stringContaining("Uncommitted WIP will not be included"),
    );
    expect(merge).toHaveBeenCalledWith(
      "workspace-1",
      "project-1",
      branch.branch,
    );
    expect(
      await screen.findByText(`Merged ${branch.branch} into main.`),
    ).toBeTruthy();
  });

  it("surfaces a structured conflict and disables unsafe branches", async () => {
    const conflictKey = `merge:${project.id}:${branch.branch}`;
    const merge = vi.fn(async () => {
      useAppV2Store.setState({
        conflictsByKey: {
          [conflictKey]: {
            message: "Conversation branch conflicts with main",
            occurredAt: Date.now(),
          },
        },
      });
      return "conflict" as const;
    });
    useAppV2Store.setState({ mergeConversationBranch: merge });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const { rerender } = render(
      <AppV2ConversationBranchesPanel
        workspaceId="workspace-1"
        project={project}
        branches={[branch]}
      />,
    );

    await userEvent.click(
      screen.getByRole("button", { name: "Merge into main" }),
    );
    expect(
      await screen.findByText("Conversation branch conflicts with main"),
    ).toBeTruthy();
    await waitFor(() =>
      expect(
        (
          screen.getByRole("button", {
            name: "Merge into main",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(true),
    );

    useAppV2Store.setState({ conflictsByKey: {} });
    rerender(
      <AppV2ConversationBranchesPanel
        workspaceId="workspace-1"
        project={project}
        branches={[
          { ...branch, dirty: true },
          {
            ...branch,
            chatId: "64b7f0f0f0f0f0f0f0f0f0f1",
            branch: "mako/chat/64b7f0f0f0f0f0f0f0f0f0f1",
            aheadBy: 0,
          },
          {
            ...branch,
            chatId: "64b7f0f0f0f0f0f0f0f0f0f2",
            branch: "mako/chat/64b7f0f0f0f0f0f0f0f0f0f2",
            status: "conflict",
          },
        ]}
      />,
    );
    for (const button of screen.getAllByRole("button", {
      name: "Merge into main",
    })) {
      expect((button as HTMLButtonElement).disabled).toBe(true);
    }
  });
});
