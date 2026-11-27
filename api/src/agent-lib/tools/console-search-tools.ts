import { tool } from "ai";
import { z } from "zod";
import { Types } from "mongoose";
import type { AgentToolExecutionContext } from "../../agents/types";
import { connectionsRepo } from "../../repositories/connections";
import { consolesChartsRepo } from "../../repositories/consoles-charts";
import {
  embedText,
  isEmbeddingAvailable,
  isVectorSearchAvailable,
  getEmbeddingModelName,
} from "../../services/embedding.service";
import { loggers } from "../../logging";
import {
  isAgentToolAbortError,
  registerAgentExecution,
  throwIfAborted,
} from "./shared/truncation";

const logger = loggers.agent();

interface ConsoleSearchResult {
  id: string;
  title: string;
  description: string;
  connectionName?: string;
  databaseName?: string;
  language: string;
  isSaved: boolean;
  score: number;
}

async function vectorSearch(
  queryEmbedding: number[],
  workspaceId: string,
  limit: number,
  embeddingModel?: string | null,
): Promise<any[]> {
  return consolesChartsRepo.searchConsolesVector(workspaceId, queryEmbedding, {
    limit,
    embeddingModel,
  });
}

async function textSearch(
  query: string,
  workspaceId: string,
  limit: number,
): Promise<any[]> {
  return consolesChartsRepo.searchConsolesText(workspaceId, query, { limit });
}

async function regexNameSearch(
  query: string,
  workspaceId: string,
  limit: number,
): Promise<any[]> {
  return consolesChartsRepo.searchConsolesName(workspaceId, query, { limit });
}

function computeCompositeScore(item: any, maxRelevanceScore: number): number {
  const relevanceNorm =
    maxRelevanceScore > 0 ? item.score / maxRelevanceScore : 0;

  const now = Date.now();
  const updated = item.updatedAt ? new Date(item.updatedAt).getTime() : now;
  const daysSinceUpdate = (now - updated) / 86400000;
  const recencyScore = Math.exp(-0.023 * daysSinceUpdate);

  const savedBoost = item.isSaved ? 1.0 : 0.0;

  return relevanceNorm * 0.6 + recencyScore * 0.2 + savedBoost * 0.2;
}

export async function enrichWithConnectionNames(
  results: ConsoleSearchResult[],
  workspaceId: string,
): Promise<void> {
  const connectionIds = [
    ...new Set(
      results
        .filter((r: any) => r.connectionId)
        .map((r: any) => r.connectionId),
    ),
  ];
  if (connectionIds.length === 0) return;

  const validConnectionIds = connectionIds.filter(id =>
    Types.ObjectId.isValid(id),
  );
  if (validConnectionIds.length === 0) return;

  // Only this workspace's connections: a console row can carry any id.
  const connections =
    await connectionsRepo.findDatabaseConnectionSummariesByIds(
      validConnectionIds,
      workspaceId,
    );

  const nameMap = new Map(connections.map(c => [c.id, c.name]));

  for (const r of results as any[]) {
    if (r.connectionId) {
      r.connectionName = nameMap.get(r.connectionId);
    }
    delete r.connectionId;
    delete r.updatedAt;
  }
}

export async function searchConsoles(
  query: string,
  workspaceId: string,
  limit: number = 5,
  signal?: AbortSignal,
): Promise<ConsoleSearchResult[]> {
  let results: any[] = [];

  throwIfAborted(signal);
  const canVector =
    isEmbeddingAvailable() && (await isVectorSearchAvailable(workspaceId));

  if (canVector) {
    try {
      const embedding = await embedText(query);
      if (embedding) {
        const currentModel = getEmbeddingModelName();
        const vectorResults = await vectorSearch(
          embedding,
          workspaceId,
          limit,
          currentModel,
        );
        throwIfAborted(signal);
        results = vectorResults.filter(
          (r: any) => !r.embeddingModel || r.embeddingModel === currentModel,
        );
      }
    } catch (err) {
      if (isAgentToolAbortError(err)) throw err;
      logger.warn("Vector search failed, falling back to text search", {
        error: err,
      });
    }
  }

  if (results.length < limit) {
    try {
      const textResults = await textSearch(query, workspaceId, limit);
      throwIfAborted(signal);
      const existingIds = new Set(results.map(r => r.id));
      for (const tr of textResults) {
        if (!existingIds.has(tr.id)) {
          results.push(tr);
        }
      }
    } catch (err) {
      if (isAgentToolAbortError(err)) throw err;
      logger.warn("Text search failed, falling back to regex", { error: err });
    }
  }

  if (results.length < limit) {
    try {
      const regexResults = await regexNameSearch(query, workspaceId, limit);
      throwIfAborted(signal);
      const existingIds = new Set(results.map(r => r.id));
      for (const rr of regexResults) {
        if (!existingIds.has(rr.id)) {
          results.push(rr);
        }
      }
    } catch (err) {
      if (isAgentToolAbortError(err)) throw err;
      logger.warn("Regex name search failed", { error: err });
    }
  }

  if (results.length === 0) return [];

  const maxScore = Math.max(...results.map(r => r.score), 0.001);
  for (const r of results) {
    r.compositeScore = computeCompositeScore(r, maxScore);
  }

  results.sort((a, b) => b.compositeScore - a.compositeScore);
  results = results.slice(0, limit);

  await enrichWithConnectionNames(results, workspaceId);
  throwIfAborted(signal);

  return results.map(r => ({
    id: r.id,
    title: r.title,
    description: r.description,
    connectionName: r.connectionName,
    databaseName: r.databaseName,
    language: r.language,
    isSaved: r.isSaved,
    score: Math.round(r.compositeScore * 100) / 100,
  }));
}

export const createConsoleSearchTools = (
  workspaceId: string,
  toolExecutionContext?: AgentToolExecutionContext,
) => ({
  search_consoles: tool({
    description:
      "Search saved consoles across the workspace by semantic meaning or keywords. Returns matching consoles ranked by relevance and recency. Use this to find past queries, discover existing work, or locate a console the user mentions. Results include id, title, description, connection info, and language.",
    inputSchema: z.object({
      query: z
        .string()
        .describe(
          "Natural language search query (e.g. 'sales leaderboard france')",
        ),
      limit: z
        .number()
        .optional()
        .default(5)
        .describe("Max results to return (default 5)"),
    }),
    execute: async ({ query, limit }) => {
      const { signal, release } = registerAgentExecution(
        toolExecutionContext,
        "agent-search-consoles",
      );
      try {
        throwIfAborted(signal);
        return await searchConsoles(query, workspaceId, limit || 5, signal);
      } catch (error) {
        return {
          success: false,
          error: isAgentToolAbortError(error)
            ? "Console search cancelled because the chat stopped."
            : error instanceof Error
              ? error.message
              : "Failed to search consoles",
        };
      } finally {
        release();
      }
    },
  }),
});
