// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  buildAppV2CommandArgv,
  parseAppV2PackageList,
} from "../apps-v2-runtime/command";
import AppV2CommandPanel from "./AppV2CommandPanel";
import { useAppV2Store } from "../store/appV2Store";

const workspaceId = "workspace-1";
const projectId = "project-1";
const session = {
  worktreeId: "worktree-1",
  provider: "e2b",
  sandboxId: "sandbox-1",
  generation: 1,
  leaseEpoch: 1,
  appliedWipOid: "a".repeat(40),
  status: "active" as const,
  lastActiveAt: "2026-01-01T00:00:00.000Z",
};

beforeEach(() => {
  vi.restoreAllMocks();
  useAppV2Store.setState({
    availabilityByWorkspace: {
      [workspaceId]: {
        enabled: true,
        sandboxAvailable: true,
        sandboxProvider: "e2b",
        loaded: true,
        loading: false,
        error: null,
      },
    },
    sessionsByProject: { [projectId]: session },
    sessionCommandsByProject: {},
    sessionFlushesByProject: {},
    sessionIssuesByProject: {},
    loadingByKey: {},
  });
});

afterEach(() => cleanup());

describe("AppV2CommandPanel", () => {
  it("keeps shell-looking arguments as discrete argv data", () => {
    expect(
      buildAppV2CommandArgv(
        "node",
        "-e\nconsole.log('$HOME; touch /tmp/not-run')\n$(whoami)",
      ),
    ).toEqual([
      "node",
      "-e",
      "console.log('$HOME; touch /tmp/not-run')",
      "$(whoami)",
    ]);
  });

  it("validates finite registry package lists", () => {
    expect(parseAppV2PackageList("react@18.3.1\n@scope/pkg@latest")).toEqual({
      packages: ["react@18.3.1", "@scope/pkg@latest"],
      error: null,
    });
    expect(parseAppV2PackageList("file:../private-package").error).toMatch(
      /not a valid npm registry package spec/,
    );
    expect(parseAppV2PackageList("safe;touch").error).toMatch(
      /not a valid npm registry package spec/,
    );
  });

  it("retains the informative disabled state when sandbox is unavailable", () => {
    useAppV2Store.setState({
      availabilityByWorkspace: {
        [workspaceId]: {
          enabled: true,
          sandboxAvailable: false,
          sandboxProvider: "off",
          loaded: true,
          loading: false,
          error: null,
        },
      },
    });
    render(
      <AppV2CommandPanel
        workspaceId={workspaceId}
        projectId={projectId}
        readOnly={false}
      />,
    );

    expect(
      screen.getByText(/isolated execution is not provisioned/i),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: /run command/i })).toBeNull();
  });

  it("constructs argv and installs validated packages without a terminal", async () => {
    const user = userEvent.setup();
    const execSession = vi
      .spyOn(useAppV2Store.getState(), "execSession")
      .mockResolvedValue(null);
    const installPackages = vi
      .spyOn(useAppV2Store.getState(), "installPackages")
      .mockResolvedValue(null);
    vi.spyOn(
      useAppV2Store.getState(),
      "fetchStatusWithRetry",
    ).mockResolvedValue(true);
    vi.spyOn(useAppV2Store.getState(), "getSession").mockResolvedValue(session);

    render(
      <AppV2CommandPanel
        workspaceId={workspaceId}
        projectId={projectId}
        readOnly={false}
      />,
    );
    const executable = screen.getByLabelText("Executable");
    const args = screen.getByLabelText("Arguments");
    await user.clear(executable);
    await user.type(executable, "node");
    await user.clear(args);
    await user.type(args, "-e\nconsole.log('$HOME; touch /tmp/not-run')");
    await user.click(screen.getByRole("button", { name: "Run command" }));

    expect(execSession).toHaveBeenCalledWith(workspaceId, projectId, [
      "node",
      "-e",
      "console.log('$HOME; touch /tmp/not-run')",
    ]);

    const packages = screen.getByLabelText("Packages");
    await user.type(packages, "file:../private-package");
    expect(
      screen.getByRole("button", { name: "Install packages" }),
    ).toHaveProperty("disabled", true);
    await user.clear(packages);
    await user.type(packages, "react@18.3.1\n@scope/pkg@latest");
    await user.click(screen.getByRole("button", { name: "Install packages" }));
    expect(installPackages).toHaveBeenCalledWith(workspaceId, projectId, [
      "react@18.3.1",
      "@scope/pkg@latest",
    ]);
    expect(screen.queryByRole("textbox", { name: /terminal/i })).toBeNull();
  });
});
