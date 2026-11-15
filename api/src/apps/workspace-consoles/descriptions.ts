/**
 * DERIVATION (apps.md §16.4). Description + embedding are derived from the
 * file and stamped with `descriptionSourceSha`; `deriveConsoleDescription`
 * runs only while that differs from `sourceBlobSha`, behind a debounced
 * Inngest function.
 */
import { Types } from "mongoose";
import { inngest } from "../../inngest/client";
import { SavedConsole } from "../../database/workspace-schema";
import { loggers } from "../../logging";
import {
  generateDescriptionAndEmbedding,
  isDescriptionGenAvailable,
} from "../../services/console-description.service";
import {
  embedText,
  getEmbeddingModelName,
  isEmbeddingAvailable,
} from "../../services/embedding.service";
import { descriptionIsAuthored } from "./files";

const logger = loggers.api("consoles-git");

export const CONSOLE_DESCRIPTION_EVENT = "console/description.requested";

export interface ConsoleDescriptionEventData {
  workspaceId: string;
  consoleId: string;
  /** Agent-turn context that only exists inside the turn (§16.4). */
  context?: { conversationExcerpt?: string; resultSample?: string };
  tracking?: { userId: string; userEmail?: string };
}

/** Ask for description + embedding derivation; debounced server-side. */
export function requestConsoleDescription(
  data: ConsoleDescriptionEventData,
): void {
  void inngest.send({ name: CONSOLE_DESCRIPTION_EVENT, data }).catch(error => {
    logger.warn("Console description request could not be queued", {
      consoleId: data.consoleId,
      error: error instanceof Error ? error.message : String(error),
    });
  });
}

export type DeriveOutcome =
  "updated" | "current" | "unavailable" | "missing" | "raced";

/**
 * Derive description + embedding for one console from its indexed content.
 * Runs only while `descriptionSourceSha` differs from `sourceBlobSha`; the
 * write is guarded on `sourceBlobSha` so a slow result never lands on a
 * newer file. Authored descriptions are embedded as they are — no LLM call.
 */
export async function deriveConsoleDescription(
  consoleId: string,
  options: {
    context?: ConsoleDescriptionEventData["context"];
    tracking?: ConsoleDescriptionEventData["tracking"];
    force?: boolean;
  } = {},
): Promise<DeriveOutcome> {
  const row = await SavedConsole.findById(consoleId).populate<{
    connectionId?: { name?: string; type?: string } | null;
  }>("connectionId", "name type");
  if (!row) return "missing";
  const sourceSha = row.sourceBlobSha;
  const currentModel = getEmbeddingModelName();
  const modelStale =
    Boolean(row.embeddingModel) && row.embeddingModel !== currentModel;
  if (
    !options.force &&
    sourceSha &&
    row.descriptionSourceSha === sourceSha &&
    !modelStale
  ) {
    return "current";
  }

  const authored = descriptionIsAuthored(row);
  let description: string | null = authored ? (row.description ?? null) : null;
  if (!authored) {
    if (!isDescriptionGenAvailable()) return "unavailable";
    const connection = row.connectionId as
      { name?: string; type?: string } | null | undefined;
    const generated = await generateDescriptionAndEmbedding(
      {
        code: row.code ?? "",
        title: row.name,
        connectionName: connection?.name,
        databaseType: connection?.type,
        databaseName: row.databaseName,
        language: row.language,
        conversationExcerpt: options.context?.conversationExcerpt,
        resultSample: options.context?.resultSample,
      },
      options.tracking
        ? { workspaceId: row.workspaceId.toString(), ...options.tracking }
        : undefined,
    );
    description = generated.description;
    if (!description) return "unavailable";
    const set: Record<string, unknown> = {
      description,
      descriptionSource: "generated",
      descriptionGeneratedAt: new Date(),
      descriptionSourceSha: sourceSha ?? null,
    };
    if (generated.embedding) {
      set.descriptionEmbedding = generated.embedding;
      set.embeddingModel = generated.embeddingModel;
    }
    return guardedWrite(row._id, sourceSha, set);
  }

  // Authored: embed the text as written.
  const set: Record<string, unknown> = {
    descriptionSource: "authored",
    descriptionSourceSha: sourceSha ?? null,
  };
  if (isEmbeddingAvailable() && description) {
    try {
      const embedding = await embedText(description);
      if (embedding) {
        set.descriptionEmbedding = embedding;
        set.embeddingModel = currentModel;
      }
    } catch (error) {
      logger.warn("Console embedding failed", {
        consoleId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return guardedWrite(row._id, sourceSha, set);
}

async function guardedWrite(
  id: Types.ObjectId,
  sourceSha: string | undefined,
  set: Record<string, unknown>,
): Promise<DeriveOutcome> {
  const filter: Record<string, unknown> = { _id: id };
  // Rows never projected to git (drafts, unadopted workspaces) have no sha
  // to guard on; a projected row must still be at the sha we derived from.
  if (sourceSha) filter.sourceBlobSha = sourceSha;
  else filter.sourceBlobSha = { $in: [null, undefined] };
  const result = await SavedConsole.updateOne(filter, { $set: set });
  return result.matchedCount > 0 ? "updated" : "raced";
}

/**
 * Queue derivation for every row whose description is behind its content or
 * whose embedding model is stale — the one reconcile rule (§16.4). Scoped
 * to a workspace when given.
 */
export async function reconcileConsoleDescriptions(
  workspaceId?: string,
): Promise<number> {
  const currentModel = getEmbeddingModelName();
  const filter: Record<string, unknown> = {
    isSaved: true,
    $or: [{ is_deleted: { $ne: true } }, { is_deleted: { $exists: false } }],
    $and: [
      {
        $or: [
          { $expr: { $ne: ["$descriptionSourceSha", "$sourceBlobSha"] } },
          ...(currentModel
            ? [{ embeddingModel: { $exists: true, $ne: currentModel } }]
            : []),
        ],
      },
    ],
  };
  if (workspaceId) filter.workspaceId = new Types.ObjectId(workspaceId);
  const rows = await SavedConsole.find(filter)
    .select("_id workspaceId")
    .lean<Array<{ _id: Types.ObjectId; workspaceId: Types.ObjectId }>>();
  for (const row of rows) {
    requestConsoleDescription({
      workspaceId: row.workspaceId.toString(),
      consoleId: row._id.toString(),
    });
  }
  return rows.length;
}
