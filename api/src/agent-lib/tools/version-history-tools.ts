import { tool } from "ai";
import { z } from "zod";
import {
  listVersions,
  getVersion,
} from "../../services/entity-version.service";

export const createVersionHistoryTools = (workspaceId: string) => ({
  browse_version_history: tool({
    description:
      "Browse the version history of a saved console, dashboard, or legacy " +
      "(pre-git) app. " +
      "Returns a list of past versions with who saved them, when, and their commit comment. " +
      "Use after search_consoles or search_dashboards to inspect change history, " +
      "understand who changed what, or help the user decide which version to restore " +
      "(restore dashboards with restore_version; consoles restore via their own " +
      "flows; legacy app history is read-only — git-backed apps version through git). " +
      "Pass the entityId from a search result.",
    inputSchema: z.object({
      entityType: z
        .enum(["console", "dashboard", "app"])
        .describe("Whether this is a console, dashboard, or app"),
      entityId: z.string().describe("The ID of the console, dashboard, or app"),
      limit: z
        .number()
        .optional()
        .default(10)
        .describe("Max versions to return (default 10)"),
    }),
    execute: async ({ entityType, entityId, limit }) => {
      try {
        const result = await listVersions(entityId, entityType, {
          limit: limit || 10,
          workspaceId,
        });
        return {
          success: true as const,
          entityType,
          entityId,
          total: result.total,
          versions: result.versions.map(v => ({
            version: v.version,
            savedBy: v.savedByName,
            comment: v.comment || "(no comment)",
            restoredFrom: v.restoredFrom ?? null,
            createdAt: v.createdAt,
          })),
          message: `Found ${result.total} version(s) for this ${entityType}`,
        };
      } catch (error) {
        return {
          success: false as const,
          error:
            error instanceof Error
              ? error.message
              : "Failed to browse version history",
        };
      }
    },
  }),

  get_version_snapshot: tool({
    description:
      "Get the full snapshot of a specific version of a console, dashboard, or app. " +
      "Use this to show the user what a past version looked like, or to compare " +
      "with the current state. For consoles, the snapshot includes the code; " +
      "for dashboards, it includes widgets, data sources, and layout; for apps, " +
      "it includes the files, dependencies, and data binding queries.",
    inputSchema: z.object({
      entityType: z
        .enum(["console", "dashboard", "app"])
        .describe("Whether this is a console, dashboard, or app"),
      entityId: z.string().describe("The ID of the console, dashboard, or app"),
      version: z.number().describe("The version number to retrieve"),
    }),
    execute: async ({ entityType, entityId, version }) => {
      try {
        const v = await getVersion(entityId, entityType, version, workspaceId);
        if (!v) {
          return {
            success: false as const,
            error: `Version ${version} not found`,
          };
        }
        return {
          success: true as const,
          entityType,
          entityId,
          version: v.version,
          savedBy: v.savedByName,
          comment: v.comment || "(no comment)",
          restoredFrom: v.restoredFrom ?? null,
          createdAt: v.createdAt,
          snapshot: v.snapshot,
        };
      } catch (error) {
        return {
          success: false as const,
          error:
            error instanceof Error
              ? error.message
              : "Failed to get version snapshot",
        };
      }
    },
  }),
});
