import { z } from "zod";
import { Types } from "mongoose";
import type { AgentToolExecutionContext } from "../../agents/types";
import {
  SavedConsole,
  DatabaseConnection,
} from "../../database/workspace-schema";
import {
  embedText,
  isEmbeddingAvailable,
  isVectorSearchAvailable,
  getEmbeddingModelName,
} from "../../services/embedding.service";
import { databaseConnectionService } from "../../services/database-connection.service";
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
): Promise<ConsoleSearchResult[]> {
  const { db } = await databaseConnectionService.getMainConnection();
  const results = await db
    .collection("savedconsoles")
    .aggregate([
      {
        $vectorSearch: {
          index: "console_embeddings",
          path: "descriptionEmbedding",
          queryVector: queryEmbedding,
          numCandidates: limit * 10,
          limit: limit * 2,
          filter: {
            workspaceId: new Types.ObjectId(workspaceId),
            is_deleted: { $ne: true },
          },
        },
      },
      {
        $addFields: {
          vectorScore: { $meta: "vectorSearchScore" },
        },
      },
      {
        $project: {
          _id: 1,
          name: 1,
          description: 1,
          connectionId: 1,
          databaseName: 1,
          language: 1,
          isSaved: 1,
          updatedAt: 1,
          vectorScore: 1,
        },
      },
    ])
    .toArray();

  return results
    .filter(r => r.isSaved === true)
    .map(r => ({
      id: r._id.toString(),
      title: r.name,
      description: r.description || "",
      connectionId: r.connectionId?.toString(),
      databaseName: r.databaseName,
      language: r.language,
      isSaved: true,
      updatedAt: r.updatedAt,
      score: r.vectorScore || 0,
    })) as any[];
}

async function textSearch(
  query: string,
  workspaceId: string,
  limit: number,
): Promise<ConsoleSearchResult[]> {
  const results = await SavedConsole.find(
    {
      $text: { $search: query },
      workspaceId: new Types.ObjectId(workspaceId),
      isSaved: true,
      $or: [{ is_deleted: { $ne: true } }, { is_deleted: { $exists: false } }],
    },
    { score: { $meta: "textScore" } },
  )
    .select(
      "name description connectionId databaseName language isSaved updatedAt",
    )
    .sort({ score: { $meta: "textScore" } })
    .limit(limit * 2)
    .lean();

  return results.map((r: any) => ({
    id: r._id.toString(),
    title: r.name,
    description: r.description || "",
    connectionId: r.connectionId?.toString(),
    databaseName: r.databaseName,
    language: r.language,
    isSaved: r.isSaved === true,
    updatedAt: r.updatedAt,
    score: r._score || 0,
  }));
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function regexNameSearch(
  query: string,
  workspaceId: string,
  limit: number,
): Promise<ConsoleSearchResult[]> {
  const results = await SavedConsole.find({
    name: { $regex: escapeRegex(query), $options: "i" },
    workspaceId: new Types.ObjectId(workspaceId),
    isSaved: true,
    $or: [{ is_deleted: { $ne: true } }, { is_deleted: { $exists: false } }],
  })
    .select(
      "name description connectionId databaseName language isSaved updatedAt",
    )
    .sort({ updatedAt: -1 })
    .limit(limit * 2)
    .lean();

  return results.map((r: any) => ({
    id: r._id.toString(),
    title: r.name,
    description: r.description || "",
    connectionId: r.connectionId?.toString(),
    databaseName: r.databaseName,
    language: r.language,
    isSaved: r.isSaved === true,
    updatedAt: r.updatedAt,
    score: 0.5,
  }));
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

async function enrichWithConnectionNames(
  results: ConsoleSearchResult[],
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

  const connections = await DatabaseConnection.find({
    _id: { $in: validConnectionIds.map(id => new Types.ObjectId(id)) },
  })
    .select("name")
    .lean();

  const nameMap = new Map(connections.map(c => [c._id.toString(), c.name]));

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
  const canVector = isEmbeddingAvailable() && (await isVectorSearchAvailable());

  if (canVector) {
    try {
      const embedding = await embedText(query);
      if (embedding) {
        const currentModel = getEmbeddingModelName();
        const vectorResults = await vectorSearch(embedding, workspaceId, limit);
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

  await enrichWithConnectionNames(results);
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
  search_consoles: {
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
    execute: async ({ query, limit }: { query: string; limit?: number }) => {
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
  },
});
