import { AppV2ProjectService } from "./app-project.service";
import { AppV2WorktreeService } from "./worktree.service";
import { AppV2SessionService } from "./session.service";
import { CloudSessionExecutor } from "./cloud-session-executor";
import { createAppsV2SandboxProvider } from "./providers/sandbox-provider-factory";

export interface AppV2Services {
  projects: AppV2ProjectService;
  worktrees: AppV2WorktreeService;
  sessions: AppV2SessionService | undefined;
}

let projectService: AppV2ProjectService | undefined;
let worktreeService: AppV2WorktreeService | undefined;
let sessionService: AppV2SessionService | undefined;

/**
 * Shared Apps v2 service graph for HTTP routes and agent tools. Sandbox
 * provider configuration is resolved only here so every caller gets the same
 * provider, executor, Git provider, and worktree service wiring.
 */
export function getAppV2Services(): AppV2Services {
  projectService ??= new AppV2ProjectService();
  worktreeService ??= new AppV2WorktreeService(projectService);

  if (!sessionService) {
    const provider = createAppsV2SandboxProvider();
    if (provider) {
      sessionService = new AppV2SessionService(
        provider.name,
        new CloudSessionExecutor(provider, projectService, worktreeService),
        worktreeService,
      );
    }
  }

  return {
    projects: projectService,
    worktrees: worktreeService,
    sessions: sessionService,
  };
}
