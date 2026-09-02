import { embed, embedMany } from "ai";
import {
  gatewayAttributionOptions,
  getEmbeddingModel,
  type GatewayAttribution,
} from "../agent-lib/ai-gateway";
import { loggers } from "../logging";
import { databaseConnectionService } from "./database-connection.service";

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

/**
 * Who the embedding is for, for Vercel spend attribution. Embeddings are
 * cheap but numerous (they were the whole of the gateway's untagged traffic),
 * and an untagged request is one nobody can explain later. Callers pass the
 * workspace (and user, when a person triggered it); the type is always
 * `embedding`.
 */
export type EmbeddingAttribution = Omit<GatewayAttribution, "invocationType">;

// `Record<string, any>` for the same reason `buildProviderOptions` returns
// it: the SDK's provider-options type is a JSON record, and the typed
// gateway options object (optional fields, `undefined`) is not assignable.
function embeddingProviderOptions(
  attribution?: EmbeddingAttribution,
): Record<string, any> {
  return {
    gateway: gatewayAttributionOptions({
      ...attribution,
      invocationType: "embedding",
    }),
  };
}

export async function embedText(
  text: string,
  attribution?: EmbeddingAttribution,
): Promise<number[] | null> {
  if (!isEmbeddingAvailable()) return null;

  const { embedding } = await embed({
    model: getEmbeddingModel(GATEWAY_EMBEDDING_MODEL_ID),
    value: text,
    providerOptions: embeddingProviderOptions(attribution),
    experimental_telemetry: {
      isEnabled: true,
      functionId: "embed-text",
      metadata: { model: EMBEDDING_MODEL_LABEL },
    },
  });
  return embedding;
}

export async function embedTexts(
  texts: string[],
  attribution?: EmbeddingAttribution,
): Promise<(number[] | null)[]> {
  if (!isEmbeddingAvailable() || texts.length === 0) {
    return texts.map(() => null);
  }

  const { embeddings } = await embedMany({
    model: getEmbeddingModel(GATEWAY_EMBEDDING_MODEL_ID),
    values: texts,
    providerOptions: embeddingProviderOptions(attribution),
    experimental_telemetry: {
      isEnabled: true,
      functionId: "embed-texts",
      metadata: { model: EMBEDDING_MODEL_LABEL, count: texts.length },
    },
  });
  return embeddings;
}

let _vectorSearchAvailable: boolean | null = null;

export async function isVectorSearchAvailable(): Promise<boolean> {
  if (_vectorSearchAvailable !== null) return _vectorSearchAvailable;
  try {
    const { db } = await databaseConnectionService.getMainConnection();
    await db
      .collection("savedconsoles")
      .aggregate([
        {
          $vectorSearch: {
            index: "console_embeddings",
            path: "descriptionEmbedding",
            queryVector: Array.from({ length: 1536 }, (_, i) =>
              i === 0 ? 1 : 0,
            ),
            numCandidates: 1,
            limit: 1,
          },
        },
      ])
      .toArray();
    _vectorSearchAvailable = true;
  } catch {
    _vectorSearchAvailable = false;
    logger.info(
      "Atlas Vector Search not available — falling back to text search",
    );
  }
  return _vectorSearchAvailable;
}

export function resetVectorSearchCache(): void {
  _vectorSearchAvailable = null;
}
