import { generateText } from "ai";
import { getModel, buildProviderOptions } from "../agent-lib/ai-gateway";
import {
  isGatewayMode,
  getUtilityModelId,
  getConfiguredProviders,
  getAvailableModels,
} from "../agent-lib/ai-models";
import type { GatewayLanguageModelOptions } from "@ai-sdk/gateway";
import { trackUsage } from "./llm-usage.service";
import { loggers } from "../logging";
import {
  embedText,
  isEmbeddingAvailable,
  getEmbeddingModelName,
} from "./embedding.service";
import { toNum } from "../utils/safe-num";

const logger = loggers.app();

function processDescriptionResult(
  text: string,
  usage: Record<string, unknown>,
  modelId: string,
  trackingCtx?: DescriptionTrackingContext | null,
): string | null {
  if (trackingCtx) {
    const inputTokens =
      usage.promptTokens !== undefined
        ? toNum(usage.promptTokens)
        : toNum(usage.inputTokens);
    const outputTokens =
      usage.completionTokens !== undefined
        ? toNum(usage.completionTokens)
        : toNum(usage.outputTokens);
    void trackUsage({
      workspaceId: trackingCtx.workspaceId,
      userId: trackingCtx.userId,
      invocationType: "description_generation",
      modelId,
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
    }).catch(err =>
      logger.warn("Failed to track description usage", { error: err }),
    );
  }

  let description = text.trim();
  description = description.replace(/^["']|["']$/g, "");
  description = description.substring(0, 500);

  if (description.length < 5) return null;
  return description;
}

/**
 * Description generation requires at least one configured LLM provider
 * (or the AI Gateway).
 */
export function isDescriptionGenAvailable(): boolean {
  return isGatewayMode() || getConfiguredProviders().length > 0;
}

const DESCRIPTION_SYSTEM_PROMPT = `You are a concise technical writer. Generate a 1-2 sentence description of the given database query.

Rules:
- Focus on the business intent and what data it retrieves
- Mention key filters, groupings, or conditions
- Mention what insights the results reveal if result data is provided
- Be specific: "Monthly renewal cohorts for CMA product grouped by signup month" not "A query that joins tables"
- Do NOT start with "This query" — just describe what it does directly
- Return only the description, nothing else`;

export interface ConsoleDescriptionContext {
  code: string;
  title?: string;
  connectionName?: string;
  databaseType?: string;
  databaseName?: string;
  language: string;
  conversationExcerpt?: string;
  resultSample?: string;
}

export interface DescriptionTrackingContext {
  workspaceId: string;
  userId: string;
}

export async function generateConsoleDescription(
  context: ConsoleDescriptionContext,
  trackingCtx?: DescriptionTrackingContext,
): Promise<string | null> {
  const parts: string[] = [];

  if (context.title) {
    parts.push(`Title: ${context.title}`);
  }

  if (context.connectionName || context.databaseType || context.databaseName) {
    const connParts: string[] = [];
    if (context.connectionName) connParts.push(context.connectionName);
    if (context.databaseType) connParts.push(`(${context.databaseType})`);
    if (context.databaseName) connParts.push(`/ ${context.databaseName}`);
    parts.push(`Connection: ${connParts.join(" ")}`);
  }

  parts.push(`Language: ${context.language}`);
  parts.push("");
  parts.push("Query:");
  parts.push(context.code.substring(0, 3000));

  if (context.conversationExcerpt) {
    parts.push("");
    parts.push("Conversation context:");
    parts.push(context.conversationExcerpt.substring(0, 1000));
  }

  if (context.resultSample) {
    parts.push("");
    parts.push("Query results (sample):");
    parts.push(context.resultSample.substring(0, 500));
  }

  const prompt = parts.join("\n");

  if (!isDescriptionGenAvailable()) return null;

  if (isGatewayMode()) {
    try {
      const utilityModel = getUtilityModelId();
      if (!utilityModel) return null;
      const baseOpts = trackingCtx
        ? buildProviderOptions({
            userId: trackingCtx.userId,
            workspaceId: trackingCtx.workspaceId,
            invocationType: "description_generation",
          })
        : {};
      const gatewayBase = (baseOpts.gateway ?? {}) as Record<string, unknown>;
      const { text, usage, response } = await generateText({
        model: getModel(utilityModel),
        system: DESCRIPTION_SYSTEM_PROMPT,
        prompt,
        providerOptions: {
          gateway: {
            ...gatewayBase,
            models: [
              utilityModel,
              "anthropic/claude-3-5-haiku-latest",
              "google/gemini-2.5-flash",
            ],
          } satisfies GatewayLanguageModelOptions,
        },
      });

      const actualModelId = (response as Record<string, unknown>)?.modelId as
        | string
        | undefined;

      return processDescriptionResult(
        text,
        usage as Record<string, unknown>,
        actualModelId || utilityModel,
        trackingCtx,
      );
    } catch (err) {
      logger.error("Console description generation failed", { error: err });
      return null;
    }
  }

  const CHEAP_MODEL_IDS = new Set([
    "openai/gpt-4o-mini",
    "anthropic/claude-3-5-haiku-latest",
    "google/gemini-2.5-flash",
    "openai/gpt-4o",
    "google/gemini-2.5-pro",
  ]);
  const available = getAvailableModels()
    .filter(m => CHEAP_MODEL_IDS.has(m.id))
    .map(m => m.id);

  const preferredId = getUtilityModelId();
  if (!preferredId && available.length === 0) return null;
  const modelsToTry =
    preferredId && available.includes(preferredId)
      ? [preferredId, ...available.filter(id => id !== preferredId)]
      : preferredId
        ? [preferredId, ...available]
        : available;

  for (const modelId of modelsToTry) {
    try {
      const { text, usage } = await generateText({
        model: getModel(modelId),
        system: DESCRIPTION_SYSTEM_PROMPT,
        prompt,
      });

      return processDescriptionResult(
        text,
        usage as Record<string, unknown>,
        modelId,
        trackingCtx,
      );
    } catch (err) {
      logger.warn(
        "Console description generation failed for model, trying next",
        {
          modelId,
          error: err,
        },
      );
    }
  }

  logger.error("Console description generation failed for all models");
  return null;
}

export interface DescriptionAndEmbeddingResult {
  description: string | null;
  embedding: number[] | null;
  embeddingModel: string | null;
}

export async function generateDescriptionAndEmbedding(
  context: ConsoleDescriptionContext,
  trackingCtx?: DescriptionTrackingContext,
): Promise<DescriptionAndEmbeddingResult> {
  const description = await generateConsoleDescription(context, trackingCtx);

  let embedding: number[] | null = null;
  let embeddingModel: string | null = null;

  if (description && isEmbeddingAvailable()) {
    try {
      embedding = await embedText(description);
      embeddingModel = getEmbeddingModelName();
    } catch (err) {
      logger.error("Console embedding generation failed", { error: err });
    }
  }

  return { description, embedding, embeddingModel };
}

export interface ConsoleContext {
  consoleId: string;
  conversationExcerpt: string;
  resultSample: string;
}

function extractTextFromParts(parts: any[]): string {
  if (!Array.isArray(parts)) return "";
  return parts
    .filter((p: any) => p.type === "text" && typeof p.text === "string")
    .map((p: any) => p.text)
    .join("");
}

function extractTextFromMessage(msg: any): string {
  if (typeof msg.content === "string") return msg.content;
  if (Array.isArray(msg.parts)) return extractTextFromParts(msg.parts);
  return "";
}

function extractToolCallsFromMessage(
  msg: any,
): Array<{ toolName: string; input?: any; output?: any }> {
  const calls: Array<{ toolName: string; input?: any; output?: any }> = [];

  if (Array.isArray(msg.parts)) {
    for (const part of msg.parts) {
      if (part.type === "tool-invocation" && part.toolInvocation) {
        calls.push({
          toolName: part.toolInvocation.toolName,
          input: part.toolInvocation.args,
          output: part.toolInvocation.result,
        });
      }
    }
  }

  if (Array.isArray(msg.toolCalls)) {
    for (const tc of msg.toolCalls) {
      calls.push({
        toolName: tc.toolName,
        input: tc.input,
        output: tc.result ?? tc.output,
      });
    }
  }

  return calls;
}

function truncateResultSample(result: any): string {
  if (!result) return "";
  try {
    const str =
      typeof result === "string" ? result : JSON.stringify(result, null, 2);
    return str.substring(0, 500);
  } catch {
    return "";
  }
}

export function extractConsoleContextFromMessages(
  messages: any[],
): Map<string, ConsoleContext> {
  const contexts = new Map<string, ConsoleContext>();
  let lastModifiedConsoleId: string | null = null;

  const conversationParts: string[] = [];

  for (const msg of messages) {
    const text = extractTextFromMessage(msg);
    if (text.trim()) {
      const role = msg.role === "user" ? "User" : "Agent";
      conversationParts.push(`${role}: ${text.substring(0, 300)}`);
    }

    const toolCalls = extractToolCallsFromMessage(msg);

    for (const tc of toolCalls) {
      if (tc.toolName === "modify_console" && tc.input?.consoleId) {
        const id = tc.input.consoleId;
        lastModifiedConsoleId = id;
        if (!contexts.has(id)) {
          contexts.set(id, {
            consoleId: id,
            conversationExcerpt: "",
            resultSample: "",
          });
        }
      }

      if (tc.toolName === "create_console") {
        const id = tc.output?.consoleId || tc.input?.consoleId;
        if (id) {
          lastModifiedConsoleId = id;
          if (!contexts.has(id)) {
            contexts.set(id, {
              consoleId: id,
              conversationExcerpt: "",
              resultSample: "",
            });
          }
        }
      }

      if (
        (tc.toolName === "sql_execute_query" ||
          tc.toolName === "mongo_execute_query") &&
        lastModifiedConsoleId &&
        tc.output
      ) {
        const ctx = contexts.get(lastModifiedConsoleId);
        if (ctx) {
          ctx.resultSample = truncateResultSample(tc.output);
        }
      }
    }
  }

  const excerptStr = conversationParts.slice(-10).join("\n");

  for (const ctx of contexts.values()) {
    ctx.conversationExcerpt = excerptStr;
  }

  return contexts;
}
