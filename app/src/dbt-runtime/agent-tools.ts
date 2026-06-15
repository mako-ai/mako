/**
 * Client-side executor for the dbt agent tools.
 *
 * Mirrors `executeAppAgentTool`: the AI SDK routes dbt file tool calls to the
 * browser via `onToolCall`, and this dispatcher applies them through the same
 * dbtStore writeFile/persistFile path the editor uses, so agent edits show up
 * live in any open dbt-file tab.
 */

import { useDbtStore } from "../store/dbtStore";
import { focusDbtFileTab, getCurrentWorkspaceId } from "./shell";

type ToolResult = Record<string, unknown>;

function fail(error: string): ToolResult {
  return { success: false, error };
}

export async function executeDbtAgentTool(
  toolName: string,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const store = useDbtStore.getState();
  const workspaceId = getCurrentWorkspaceId();
  if (!workspaceId) return fail("No active workspace");

  const projectId = input.projectId as string | undefined;
  const path = input.path as string | undefined;

  const ensureProjectLoaded = async (id: string) => {
    if (!useDbtStore.getState().projectsLoaded) {
      await store.fetchProjects(workspaceId);
    }
    if (!useDbtStore.getState().filePathsByProject[id]) {
      await store.fetchFiles(workspaceId, id);
    }
    return useDbtStore.getState().projects.find(p => p._id === id);
  };

  switch (toolName) {
    case "read_dbt_project_tree": {
      if (!useDbtStore.getState().projectsLoaded) {
        await store.fetchProjects(workspaceId);
      }
      const projects = useDbtStore.getState().projects;
      if (!projectId) {
        return {
          success: true,
          projects: projects.map(project => ({
            id: project._id,
            name: project.name,
            defaultEnvironment: project.defaultEnvironment,
            environments: project.environments.map(env => ({
              name: env.name,
              targetSchema: env.targetSchema,
              connectionId: env.connectionId,
            })),
          })),
        };
      }
      const project = await ensureProjectLoaded(projectId);
      if (!project) return fail("dbt project not found");
      await store.fetchJobs(workspaceId, projectId);
      const state = useDbtStore.getState();
      return {
        success: true,
        projectId,
        name: project.name,
        defaultEnvironment: project.defaultEnvironment,
        environments: project.environments,
        files: state.filePathsByProject[projectId] ?? [],
        jobs: (state.jobsByProject[projectId] ?? []).map(job => ({
          id: job._id,
          name: job.name,
          environment: job.environment,
          commands: job.commands,
          schedule: job.schedule ?? null,
          enabled: job.enabled,
        })),
      };
    }

    case "read_dbt_file": {
      if (!projectId || !path) return fail("projectId and path are required");
      const content = await store.readFile(workspaceId, projectId, path);
      if (content === null) return fail(`File not found: ${path}`);
      return { success: true, path, contents: content };
    }

    case "create_dbt_file": {
      if (!projectId || !path) return fail("projectId and path are required");
      await ensureProjectLoaded(projectId);
      const existingPaths =
        useDbtStore.getState().filePathsByProject[projectId] ?? [];
      if (existingPaths.includes(path)) {
        return fail(
          `File already exists: ${path}. Use modify_dbt_file to change it.`,
        );
      }
      const ok = await store.createFile(
        workspaceId,
        projectId,
        path,
        (input.contents as string) ?? "",
      );
      if (!ok) return fail(`Failed to create ${path}`);
      focusDbtFileTab(projectId, path);
      return { success: true, path };
    }

    case "modify_dbt_file": {
      if (!projectId || !path) return fail("projectId and path are required");
      await ensureProjectLoaded(projectId);
      store.writeFile(projectId, path, (input.contents as string) ?? "");
      const ok = await store.persistFile(workspaceId, projectId, path);
      if (!ok) return fail(`Failed to save ${path}`);
      return { success: true, path };
    }

    case "delete_dbt_file": {
      if (!projectId || !path) return fail("projectId and path are required");
      const ok = await store.deleteFile(workspaceId, projectId, path);
      if (!ok) return fail(`Failed to delete ${path}`);
      return { success: true, path };
    }

    default:
      return fail(`Unknown dbt tool: ${toolName}`);
  }
}
