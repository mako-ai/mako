import { propagateAttributes } from "@langfuse/tracing";
import { embed, embedMany } from "ai";
import { getEmbeddingModel } from "../agent-lib/ai-gateway";
import { loggers } from "../logging";
import { hasPostgresConfig } from "../database/pg/client";
import { consolesChartsRepo } from "../repositories/consoles-charts";

const logger = loggers.app();

/**
 * Stored model label (kept stable so existing `embeddingModel` records and the
 * 1536-dim `console_embeddings` Atlas index remain compatible).
 */
const EMBEDDING_MODEL_LABEL = "text-embedding-3-small";
/** Gateway model ID routed through the Vercel AI Gateway. */
const GATEWAY_EMBEDDING_MODEL_ID = "openai/text-embedding-3-small";

export function isEmbeddingAvailable(): boolean {
  return Boolean(process.env.AI_GATEWAY_API_KEY);
}

export function getEmbeddingModelName(): string | null {
  return isEmbeddingAvailable() ? EMBEDDING_MODEL_LABEL : null;
}

export async function embedText(
  text: string,
  options: { abortSignal?: AbortSignal; maxRetries?: number } = {},
): Promise<number[] | null> {
  if (!isEmbeddingAvailable()) return null;

  const { embedding } = await propagateAttributes(
    // Metadata only: embeddings often run inside another trace (a chat turn).
    { metadata: { model: EMBEDDING_MODEL_LABEL } },
    () =>
      embed({
        model: getEmbeddingModel(GATEWAY_EMBEDDING_MODEL_ID),
        value: text,
        telemetry: { functionId: "embed-text" },
        ...(options.abortSignal ? { abortSignal: options.abortSignal } : {}),
        ...(options.maxRetries !== undefined
          ? { maxRetries: options.maxRetries }
          : {}),
      }),
  );
  return embedding;
}

export async function embedTexts(
  texts: string[],
): Promise<(number[] | null)[]> {
  if (!isEmbeddingAvailable() || texts.length === 0) {
    return texts.map(() => null);
  }

  const { embeddings } = await propagateAttributes(
    { metadata: { model: EMBEDDING_MODEL_LABEL, count: String(texts.length) } },
    () =>
      embedMany({
        model: getEmbeddingModel(GATEWAY_EMBEDDING_MODEL_ID),
        values: texts,
        telemetry: { functionId: "embed-texts" },
      }),
  );
  return embeddings;
}

let _pgVectorSearchAvailable: boolean | null = null;

export async function isVectorSearchAvailable(
  _workspaceId?: string,
): Promise<boolean> {
  // Legacy MongoMemoryServer tests without Postgres use text search. Vector
  // search in the deployed consoles repository runs on pgvector.
  if (!hasPostgresConfig()) return false;
  if (_pgVectorSearchAvailable !== null) return _pgVectorSearchAvailable;
  _pgVectorSearchAvailable = await consolesChartsRepo.isPgVectorAvailable();
  if (!_pgVectorSearchAvailable) {
    logger.info(
      "pgvector extension not available — falling back to Postgres full-text search",
    );
  }
  return _pgVectorSearchAvailable;
}

export function resetVectorSearchCache(): void {
  _pgVectorSearchAvailable = null;
}
