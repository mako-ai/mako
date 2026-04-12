import { z } from "zod";
import { Types } from "mongoose";
import type { AgentToolExecutionContext } from "../../agents/types";
import { Dashboard } from "../../database/workspace-schema";
import {
  isAgentToolAbortError,
  registerAgentExecution,
  throwIfAborted,
} from "./shared/truncation";

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

interface DashboardSearchResult {
  id: string;
  title: string;
  description: string;
  dataSourceNames: string[];
  widgetCount: number;
}

async function searchDashboardsByQuery(
  query: string,
  workspaceId: string,
  limit: number,
): Promise<DashboardSearchResult[]> {
  const escaped = escapeRegex(query);
  const results = await Dashboard.find({
    workspaceId: new Types.ObjectId(workspaceId),
    $or: [
      { title: { $regex: escaped, $options: "i" } },
      { description: { $regex: escaped, $options: "i" } },
      { "dataSources.name": { $regex: escaped, $options: "i" } },
    ],
  })
    .select("title description dataSources.name widgets")
    .sort({ updatedAt: -1 })
    .limit(limit)
    .lean();

  return results.map((r: any) => ({
    id: r._id.toString(),
    title: r.title || "Untitled",
    description: r.description || "",
    dataSourceNames: (r.dataSources || []).map((ds: any) => ds.name),
    widgetCount: r.widgets?.length ?? 0,
  }));
}

export const createDashboardSearchTools = (
  workspaceId: string,
  toolExecutionContext?: AgentToolExecutionContext,
) => ({
  search_dashboards: {
    description:
      "Search saved dashboards across the workspace by title, description, or data source name. " +
      "Returns matching dashboards ranked by recency. Use this to find dashboards the user mentions " +
      "or to discover existing dashboards. Then use open_dashboard to load one into a tab.",
    inputSchema: z.object({
      query: z
        .string()
        .describe("Search query (e.g. 'sales funnel', 'revenue')"),
      limit: z
        .number()
        .optional()
        .default(5)
        .describe("Max results to return (default 5)"),
    }),
    execute: async ({ query, limit }: { query: string; limit?: number }) => {
      const { signal, release } = registerAgentExecution(
        toolExecutionContext,
        "agent-search-dashboards",
      );
      try {
        throwIfAborted(signal);
        const results = await searchDashboardsByQuery(
          query,
          workspaceId,
          limit || 5,
        );
        throwIfAborted(signal);
        return {
          success: true as const,
          dashboards: results,
          message: `Found ${results.length} dashboard(s) matching "${query}"`,
        };
      } catch (error) {
        return {
          success: false as const,
          error: isAgentToolAbortError(error)
            ? "Dashboard search cancelled because the chat stopped."
            : error instanceof Error
              ? error.message
              : "Failed to search dashboards",
        };
      } finally {
        release();
      }
    },
  },
});
