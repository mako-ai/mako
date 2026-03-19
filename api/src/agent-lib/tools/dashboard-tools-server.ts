/**
 * Server-Side Dashboard Tools
 *
 * These tools have execute functions and run on the server.
 * They interact with MongoDB to create and manage dashboard documents.
 */

import { z } from "zod";
import { Types } from "mongoose";
import { nanoid } from "nanoid";
import { Dashboard, SavedConsole } from "../../database/workspace-schema";

const createDashboardSchema = z.object({
  title: z.string().describe("Dashboard title"),
  description: z.string().optional().describe("Brief description"),
  dataSources: z
    .array(
      z.object({
        consoleId: z
          .string()
          .describe("ID of the saved console to use as data source"),
        name: z
          .string()
          .describe(
            "Table alias in the dashboard (e.g. 'orders', 'customers')",
          ),
        timeDimension: z
          .string()
          .optional()
          .describe("Default time column for this data source"),
      }),
    )
    .min(1)
    .describe("Data sources from saved consoles"),
});

export function createDashboardServerTools(workspaceId: string) {
  return {
    create_dashboard: {
      description:
        "Create a new dashboard from saved consoles. " +
        "Each data source references a saved console whose query results will be loaded into DuckDB.",
      inputSchema: createDashboardSchema,
      execute: async (params: {
        title: string;
        description?: string;
        dataSources: Array<{
          consoleId: string;
          name: string;
          timeDimension?: string;
        }>;
      }) => {
        const { title, description, dataSources } = params;
        try {
          const resolvedSources = [];

          for (const ds of dataSources) {
            if (!Types.ObjectId.isValid(ds.consoleId)) {
              return {
                success: false,
                error: `Invalid console ID: ${ds.consoleId}`,
              };
            }

            const savedConsole = await SavedConsole.findOne({
              _id: new Types.ObjectId(ds.consoleId),
              workspaceId: new Types.ObjectId(workspaceId),
            });

            if (!savedConsole) {
              return {
                success: false,
                error: `Console not found: ${ds.consoleId}`,
              };
            }

            resolvedSources.push({
              id: nanoid(),
              name: ds.name,
              consoleId: savedConsole._id,
              connectionId: savedConsole.connectionId,
              timeDimension: ds.timeDimension,
              cache: { ttlSeconds: 3600 },
            });
          }

          const dashboard = new Dashboard({
            workspaceId: new Types.ObjectId(workspaceId),
            title,
            description,
            dataSources: resolvedSources,
            widgets: [],
            relationships: [],
            globalFilters: [],
            crossFilter: { enabled: true, resolution: "intersect" },
            layout: { columns: 12, rowHeight: 80 },
            cache: { ttlSeconds: 3600 },
            access: "private",
            createdBy: "agent",
          });

          await dashboard.save();

          return {
            success: true,
            dashboardId: dashboard._id.toString(),
            dataSources: resolvedSources.map(ds => ({
              id: ds.id,
              name: ds.name,
              consoleId: ds.consoleId.toString(),
            })),
          };
        } catch (error) {
          return {
            success: false,
            error:
              error instanceof Error
                ? error.message
                : "Failed to create dashboard",
          };
        }
      },
    },
  };
}
