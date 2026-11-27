/**
 * DERIVATION (apps.md §16.4). Description + embedding are derived from the
 * file and stamped with `descriptionSourceSha`; `deriveConsoleDescription`
 * runs only while that differs from `sourceBlobSha`, behind a debounced
 * Inngest function.
 */
import { Types } from "mongoose";
import { inngest } from "../../inngest/client";
import { DatabaseConnection } from "../../database/workspace-schema";
import { loggers } from "../../logging";
import {
  consolesChartsRepo,
  type UpdateConsolePatch,
} from "../../repositories/consoles-charts";
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
  const row = await consolesChartsRepo.findConsoleByIdGlobal(consoleId);
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
    const connection =
      row.connectionId && Types.ObjectId.isValid(row.connectionId)
        ? await DatabaseConnection.findOne({
            _id: new Types.ObjectId(row.connectionId),
            workspaceId: new Types.ObjectId(row.workspaceId),
          })
            .select("name type")
            .lean<{ name?: string; type?: string } | null>()
        : null;
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
        ? { workspaceId: row.workspaceId, ...options.tracking }
        : undefined,
    );
    description = generated.description;
    if (!description) return "unavailable";
    const patch: Pick<
      UpdateConsolePatch,
      | "description"
      | "descriptionSource"
      | "descriptionGeneratedAt"
      | "descriptionSourceSha"
      | "descriptionEmbedding"
      | "embeddingModel"
    > = {
      description,
      descriptionSource: "generated",
      descriptionGeneratedAt: new Date(),
      descriptionSourceSha: sourceSha ?? null,
    };
    if (generated.embedding) {
      patch.descriptionEmbedding = generated.embedding;
      patch.embeddingModel = generated.embeddingModel;
    }
    return guardedWrite(row.workspaceId, row.id, sourceSha, patch);
  }

  // Authored: embed the text as written.
  const patch: Pick<
    UpdateConsolePatch,
    | "descriptionSource"
    | "descriptionSourceSha"
    | "descriptionEmbedding"
    | "embeddingModel"
  > = {
    descriptionSource: "authored",
    descriptionSourceSha: sourceSha ?? null,
  };
  if (isEmbeddingAvailable() && description) {
    try {
      const embedding = await embedText(description);
      if (embedding) {
        patch.descriptionEmbedding = embedding;
        patch.embeddingModel = currentModel;
      }
    } catch (error) {
      logger.warn("Console embedding failed", {
        consoleId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return guardedWrite(row.workspaceId, row.id, sourceSha, patch);
}

async function guardedWrite(
  workspaceId: string,
  id: string,
  sourceSha: string | undefined,
  patch: Pick<
    UpdateConsolePatch,
    | "description"
    | "descriptionSource"
    | "descriptionGeneratedAt"
    | "descriptionSourceSha"
    | "descriptionEmbedding"
    | "embeddingModel"
  >,
): Promise<DeriveOutcome> {
  const matched = await consolesChartsRepo.guardedUpdateConsoleDescription(
    workspaceId,
    id,
    sourceSha,
    patch,
  );
  return matched ? "updated" : "raced";
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
  const rows = await consolesChartsRepo.listConsolesNeedingDescription({
    workspaceId,
    currentEmbeddingModel: currentModel,
  });
  for (const row of rows) {
    requestConsoleDescription({
      workspaceId: row.workspaceId,
      consoleId: row.id,
    });
  }
  return rows.length;
}
