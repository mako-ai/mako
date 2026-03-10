import { generateText, type LanguageModel } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { openai } from "@ai-sdk/openai";
import { google } from "@ai-sdk/google";
import { loggers } from "../logging";
import {
  embedText,
  isEmbeddingAvailable,
  getEmbeddingModelName,
} from "./embedding.service";

const logger = loggers.app();

function getDescriptionModel(): LanguageModel | null {
  if (process.env.ANTHROPIC_API_KEY) {
    return anthropic("claude-3-5-haiku-latest") as unknown as LanguageModel;
  }
  if (process.env.OPENAI_API_KEY) {
    return openai("gpt-4o-mini") as unknown as LanguageModel;
  }
  if (process.env.GOOGLE_GENERATIVE_AI_API_KEY) {
    return google("gemini-2.0-flash") as unknown as LanguageModel;
  }
  return null;
}

export function isDescriptionGenAvailable(): boolean {
  return getDescriptionModel() !== null;
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

export async function generateConsoleDescription(
  context: ConsoleDescriptionContext,
): Promise<string | null> {
  const model = getDescriptionModel();
  if (!model) return null;

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

  try {
    const { text } = await generateText({
      model: model as any,
      system: DESCRIPTION_SYSTEM_PROMPT,
      prompt: parts.join("\n"),
    });

    let description = text.trim();
    description = description.replace(/^["']|["']$/g, "");
    description = description.substring(0, 500);

    if (description.length < 5) return null;
    return description;
  } catch (err) {
    logger.error("Console description generation failed", { error: err });
    return null;
  }
}

export interface DescriptionAndEmbeddingResult {
  description: string | null;
  embedding: number[] | null;
  embeddingModel: string | null;
}

export async function generateDescriptionAndEmbedding(
  context: ConsoleDescriptionContext,
): Promise<DescriptionAndEmbeddingResult> {
  const description = await generateConsoleDescription(context);

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
