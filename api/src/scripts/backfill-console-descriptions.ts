/* eslint-disable no-console, no-process-exit */
/**
 * Backfill Console Descriptions & Embeddings
 *
 * Generates AI descriptions and vector embeddings for existing consoles.
 * Finds associated chat sessions for richer context (conversation + query results).
 *
 * Usage:
 *   pnpm backfill:descriptions [--workspace-id=X] [--dry-run] [--force] [--skip-embedding]
 *
 * Requires: ANTHROPIC_API_KEY or OPENAI_API_KEY or GOOGLE_GENERATIVE_AI_API_KEY for descriptions
 *           OPENAI_API_KEY for embeddings (optional — descriptions still generated without it)
 */

import * as dotenv from "dotenv";
dotenv.config();

import { ObjectId } from "mongodb";
import mongoose from "mongoose";
import {
  SavedConsole,
  Chat,
  DatabaseConnection,
  type ISavedConsole,
  type IChat,
} from "../database/workspace-schema";
import {
  generateDescriptionAndEmbedding,
  isDescriptionGenAvailable,
  type ConsoleDescriptionContext,
} from "../services/console-description.service";
import { isEmbeddingAvailable } from "../services/embedding.service";

interface Args {
  workspaceId?: string;
  dryRun: boolean;
  force: boolean;
  skipEmbedding: boolean;
  concurrency: number;
}

function parseArgs(): Args {
  const args: Args = {
    dryRun: false,
    force: false,
    skipEmbedding: false,
    concurrency: 5,
  };

  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith("--workspace-id=")) {
      args.workspaceId = arg.split("=")[1];
    } else if (arg === "--dry-run") {
      args.dryRun = true;
    } else if (arg === "--force") {
      args.force = true;
    } else if (arg === "--skip-embedding") {
      args.skipEmbedding = true;
    } else if (arg.startsWith("--concurrency=")) {
      args.concurrency = parseInt(arg.split("=")[1], 10) || 5;
    }
  }

  return args;
}

function extractModifiedConsoleIds(messages: IChat["messages"]): Set<string> {
  const ids = new Set<string>();
  for (const msg of messages) {
    if (!msg.toolCalls) continue;
    for (const tc of msg.toolCalls) {
      const input = tc.input as Record<string, unknown> | undefined;
      const result = tc.result as Record<string, unknown> | undefined;
      if (tc.toolName === "modify_console" && input?.consoleId) {
        ids.add(input.consoleId as string);
      }
      if (tc.toolName === "create_console" && result?.consoleId) {
        ids.add(result.consoleId as string);
      }
    }
  }
  return ids;
}

function extractContextFromChat(chat: IChat): {
  conversationExcerpt: string;
  resultSample: string;
} {
  const conversationParts: string[] = [];
  let resultSample = "";

  for (const msg of chat.messages || []) {
    const text =
      typeof msg.content === "string"
        ? msg.content
        : Array.isArray(msg.parts)
          ? msg.parts
              .filter(
                (p): p is { type: "text"; text: string } =>
                  p.type === "text" && typeof (p as any).text === "string",
              )
              .map(p => p.text)
              .join("")
          : "";

    if (text.trim()) {
      const role = msg.role === "user" ? "User" : "Agent";
      conversationParts.push(`${role}: ${text.substring(0, 300)}`);
    }

    if (msg.toolCalls) {
      for (const tc of msg.toolCalls) {
        if (
          (tc.toolName === "sql_execute_query" ||
            tc.toolName === "mongo_execute_query") &&
          tc.result &&
          !resultSample
        ) {
          try {
            const str =
              typeof tc.result === "string"
                ? tc.result
                : JSON.stringify(tc.result, null, 2);
            resultSample = str.substring(0, 500);
          } catch {
            // ignore
          }
        }
      }
    }
  }

  return {
    conversationExcerpt: conversationParts.slice(-10).join("\n"),
    resultSample,
  };
}

async function buildReverseIndex(
  workspaceFilter?: object,
): Promise<Map<string, IChat[]>> {
  console.log("Building reverse index: console → chats...");

  const chatFilter: any = {};
  if (workspaceFilter) {
    Object.assign(chatFilter, workspaceFilter);
  }

  const chats = await Chat.find(chatFilter)
    .select("messages pinnedConsoleId updatedAt workspaceId")
    .sort({ updatedAt: -1 })
    .lean<IChat[]>();

  console.log(`  Loaded ${chats.length} chats`);

  const index = new Map<string, IChat[]>();

  for (const chat of chats) {
    const consoleIds = new Set<string>();

    if (chat.pinnedConsoleId) {
      consoleIds.add(chat.pinnedConsoleId);
    }

    const fromMessages = extractModifiedConsoleIds(chat.messages || []);
    for (const id of fromMessages) {
      consoleIds.add(id);
    }

    for (const cid of consoleIds) {
      const existing = index.get(cid) || [];
      existing.push(chat);
      index.set(cid, existing);
    }
  }

  console.log(`  Indexed ${index.size} consoles with chat associations`);
  return index;
}

async function processConsole(
  doc: ISavedConsole,
  reverseIndex: Map<string, IChat[]>,
  connectionCache: Map<string, { name?: string; type?: string }>,
  args: Args,
): Promise<"processed" | "skipped" | "error"> {
  const id = doc._id.toString();

  if (!args.force && doc.descriptionGeneratedAt) {
    return "skipped";
  }

  if (!doc.code || doc.code.trim().length < 5) {
    return "skipped";
  }

  let connectionName: string | undefined;
  let databaseType: string | undefined;

  if (doc.connectionId) {
    const connId = doc.connectionId.toString();
    if (!connectionCache.has(connId)) {
      const conn = await DatabaseConnection.findById(connId)
        .select("name type")
        .lean();
      connectionCache.set(connId, conn || {});
    }
    const cached = connectionCache.get(connId);
    connectionName = cached?.name;
    databaseType = cached?.type;
  }

  const chats = reverseIndex.get(id) || [];
  let conversationExcerpt = "";
  let resultSample = "";

  if (chats.length > 0) {
    const bestChat = chats[0]; // sorted by updatedAt desc
    const ctx = extractContextFromChat(bestChat);
    conversationExcerpt = ctx.conversationExcerpt;
    resultSample = ctx.resultSample;
  }

  const context: ConsoleDescriptionContext = {
    code: doc.code,
    title: doc.name,
    connectionName,
    databaseType,
    databaseName: doc.databaseName,
    language: doc.language,
    conversationExcerpt,
    resultSample,
  };

  try {
    const { description, embedding, embeddingModel } =
      await generateDescriptionAndEmbedding(context);

    if (!description && !embedding) {
      return "skipped";
    }

    if (args.dryRun) {
      console.log(`  [DRY RUN] ${doc.name}: ${description}`);
      return "processed";
    }

    const $set: Record<string, any> = {
      descriptionGeneratedAt: new Date(),
    };
    if (description) $set.description = description;
    if (embedding && !args.skipEmbedding) {
      $set.descriptionEmbedding = embedding;
      $set.embeddingModel = embeddingModel;
    }

    await SavedConsole.updateOne({ _id: doc._id }, { $set });
    return "processed";
  } catch (err) {
    console.error(`  Error processing ${doc.name} (${id}):`, err);
    return "error";
  }
}

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  const args = parseArgs();

  console.log("=== Console Description Backfill ===");
  console.log(`  Dry run: ${args.dryRun}`);
  console.log(`  Force: ${args.force}`);
  console.log(`  Skip embedding: ${args.skipEmbedding}`);
  console.log(`  Concurrency: ${args.concurrency}`);
  if (args.workspaceId) {
    console.log(`  Workspace: ${args.workspaceId}`);
  }

  if (!isDescriptionGenAvailable()) {
    console.error(
      "ERROR: No AI provider configured. Set ANTHROPIC_API_KEY, OPENAI_API_KEY, or GOOGLE_GENERATIVE_AI_API_KEY.",
    );
    process.exit(1);
  }

  console.log(`  Embedding available: ${isEmbeddingAvailable()}`);

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("ERROR: DATABASE_URL not set");
    process.exit(1);
  }

  await mongoose.connect(databaseUrl);
  console.log("Connected to MongoDB");

  const workspaceFilter = args.workspaceId
    ? { workspaceId: new ObjectId(args.workspaceId) }
    : undefined;

  const reverseIndex = await buildReverseIndex(workspaceFilter);

  const query: any = {
    $or: [{ is_deleted: { $ne: true } }, { is_deleted: { $exists: false } }],
  };
  if (!args.force) {
    query.descriptionGeneratedAt = null;
  }
  if (args.workspaceId) {
    query.workspaceId = new ObjectId(args.workspaceId);
  }

  const consoles = await SavedConsole.find(query)
    .select(
      "name code language connectionId databaseName databaseId descriptionGeneratedAt workspaceId",
    )
    .lean<ISavedConsole[]>();

  console.log(`\nFound ${consoles.length} consoles to process`);

  let processed = 0;
  let skipped = 0;
  let errors = 0;
  const connectionCache = new Map<string, { name?: string; type?: string }>();

  for (let i = 0; i < consoles.length; i += args.concurrency) {
    const batch = consoles.slice(i, i + args.concurrency);
    const results = await Promise.all(
      batch.map(doc =>
        processConsole(doc, reverseIndex, connectionCache, args),
      ),
    );

    for (const result of results) {
      if (result === "processed") processed++;
      else if (result === "skipped") skipped++;
      else if (result === "error") errors++;
    }

    if ((i + args.concurrency) % 25 < args.concurrency) {
      console.log(
        `  Progress: ${Math.min(i + args.concurrency, consoles.length)}/${consoles.length} (${processed} processed, ${skipped} skipped, ${errors} errors)`,
      );
    }

    await sleep(50);
  }

  console.log("\n=== Summary ===");
  console.log(`  Processed: ${processed}`);
  console.log(`  Skipped: ${skipped}`);
  console.log(`  Errors: ${errors}`);
  console.log(`  Total: ${consoles.length}`);

  await mongoose.disconnect();
  process.exit(errors > 0 ? 1 : 0);
}

main().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});
