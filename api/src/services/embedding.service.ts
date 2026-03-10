import OpenAI from "openai";
import { loggers } from "../logging";
import { databaseConnectionService } from "./database-connection.service";

const logger = loggers.app();

type EmbeddingProvider = "openai" | "google";

export function getEmbeddingProvider(): EmbeddingProvider | null {
  if (process.env.OPENAI_API_KEY) return "openai";
  if (process.env.GOOGLE_GENERATIVE_AI_API_KEY) return "google";
  return null;
}

export function isEmbeddingAvailable(): boolean {
  return getEmbeddingProvider() !== null;
}

export function getEmbeddingModelName(): string | null {
  const provider = getEmbeddingProvider();
  if (provider === "openai") return "text-embedding-3-small";
  if (provider === "google") return "text-embedding-004";
  return null;
}

let openaiClient: OpenAI | null = null;

function getOpenAIClient(): OpenAI {
  if (!openaiClient) {
    openaiClient = new OpenAI();
  }
  return openaiClient;
}

export async function embedText(text: string): Promise<number[] | null> {
  const provider = getEmbeddingProvider();
  if (!provider) return null;

  if (provider === "openai") {
    const client = getOpenAIClient();
    const response = await client.embeddings.create({
      model: "text-embedding-3-small",
      input: text,
    });
    return response.data[0].embedding;
  }

  if (provider === "google") {
    // TODO: implement Google text-embedding-004 when needed
    logger.warn("Google embedding provider not yet implemented");
    return null;
  }

  return null;
}

export async function embedTexts(
  texts: string[],
): Promise<(number[] | null)[]> {
  const provider = getEmbeddingProvider();
  if (!provider || texts.length === 0) return texts.map(() => null);

  if (provider === "openai") {
    const client = getOpenAIClient();
    const response = await client.embeddings.create({
      model: "text-embedding-3-small",
      input: texts,
    });
    return response.data.map(d => d.embedding);
  }

  return texts.map(() => null);
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
            queryVector: new Array(1536).fill(0),
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
