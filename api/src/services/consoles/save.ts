/**
 * Saving a console from the editor: create at a path (POST), explicit save
 * or draft autosave by id, and save by path (PUT). Git first (apps.md
 * §16.3), then the guarded row write; a lost guard reverts the commit.
 *
 * Every function answers a `SaveResult`: the success payload the route
 * returns as-is, or a refusal (status + error + the conflict detail the
 * client resolves with).
 */
import { Types } from "mongoose";
import {
  DatabaseConnection,
  SavedConsole,
  type ConsoleAccessLevel,
  type ISavedConsole,
} from "../../database/workspace-schema";
import {
  commitConsoleState,
  loadLiveConsoleById,
  projectSavedConsole,
  requestConsoleDescription,
} from "../../apps/workspace-consoles.service";
import { buildConsoleWriteGuard } from "../console-save-guards";
import { publishRealtimeEvent } from "../realtime.service";
import { canWriteConsole } from "./access";
import {
  FOREIGN_CONNECTION_ERROR,
  connectionIdAllowed,
} from "./connection-scope";
import { getConsoleByPath, saveConsole } from "./crud";
import { ensureConsoleFolderPath } from "./folders";

type ConsoleLanguage = "sql" | "javascript" | "mongodb";

export type SaveResult<T> =
  | { ok: true; payload: T }
  | {
      ok: false;
      status: 403 | 404 | 409;
      error: string;
      /** Extra body fields (`conflict`, `versionConflict`, `draftConflict`). */
      detail?: Record<string, unknown>;
    };

export interface SaveActor {
  id: string;
  email?: string;
}

/** The editor's save body (PUT /:pathOrId). Fields are as the client sent them. */
export interface ConsoleSaveBody {
  content: string;
  path?: string;
  title?: string;
  isSaved?: boolean;
  comment?: string;
  connectionId?: string;
  databaseName?: string;
  databaseId?: string;
  chartSpec?: Record<string, unknown>;
  resultsViewMode?: "table" | "json" | "chart";
  access?: ConsoleAccessLevel;
  expectedVersion?: unknown;
  expectedDraftRevision?: unknown;
  clientId?: unknown;
  // Path-based saves only:
  folderId?: string;
  description?: string;
  language?: ConsoleLanguage;
  isPrivate?: boolean;
}

/** A different saved console already at `path`: the client resolves it. */
function pathConflict(existing: ISavedConsole, path: string) {
  return {
    ok: false as const,
    status: 409 as const,
    error: "conflict",
    detail: {
      conflict: {
        existingId: existing._id.toString(),
        existingContent: existing.code,
        existingName: existing.name,
        existingLanguage: existing.language,
        path,
      },
    },
  };
}

/**
 * connectionId is optional - consoles can be saved without being associated
 * with a specific database. Without one, the workspace's first connection
 * (if any) is used.
 */
async function connectionOrFirst(
  workspaceId: string,
  connectionId: string | undefined,
): Promise<string | undefined> {
  if (connectionId) return connectionId;
  const databases = await DatabaseConnection.find({ workspaceId }).limit(1);
  return databases.length > 0 ? databases[0]._id.toString() : undefined;
}

/** A connectionId from another workspace (or no such connection): 404. */
const foreignConnection = {
  ok: false as const,
  status: 404 as const,
  error: FOREIGN_CONNECTION_ERROR,
};

/** A positive integer counter the client echoed back, else undefined. */
function counter(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 1
    ? value
    : undefined;
}

function describeLater(
  workspaceId: string,
  consoleId: string,
  user: SaveActor,
) {
  requestConsoleDescription({
    workspaceId,
    consoleId,
    tracking: { userId: user.id, userEmail: user.email },
  });
}

/**
 * Save at a path through the manager (POST /, and PUT with a non-id path),
 * then start the console's version count at 1.
 */
async function saveAtPath(input: {
  workspaceId: string;
  user: SaveActor;
  path: string;
  content: string;
  connectionId: string | undefined;
  databaseName?: string;
  databaseId?: string;
  options: Parameters<typeof saveConsole>[7];
  /** Chart spec / view mode (authored: committed with the file). */
  view?: Pick<ConsoleSaveBody, "chartSpec" | "resultsViewMode">;
}): Promise<ISavedConsole> {
  const { workspaceId, user } = input;
  const savedConsole = await saveConsole(
    input.path,
    input.content,
    workspaceId,
    user.id,
    input.connectionId,
    input.databaseName,
    input.databaseId,
    input.options,
  );

  // Persist chart spec and view mode if provided (authored: they ride
  // along in the file, so the commit is re-projected with them).
  const view = input.view;
  if (
    view &&
    (view.chartSpec !== undefined || view.resultsViewMode !== undefined)
  ) {
    const chartUpdate: Record<string, unknown> = {};
    if (view.chartSpec !== undefined) {
      chartUpdate.chartSpec = view.chartSpec;
      savedConsole.chartSpec = view.chartSpec;
    }
    if (view.resultsViewMode !== undefined) {
      chartUpdate.resultsViewMode = view.resultsViewMode;
      savedConsole.resultsViewMode = view.resultsViewMode;
    }
    const committed = await commitConsoleState({
      row: savedConsole,
      previousPath: savedConsole.path,
      actorUserId: user.id,
      message: `save: ${input.path}`,
    });
    chartUpdate.path = committed.path;
    chartUpdate.sourceBlobSha = committed.sourceBlobSha;
    await SavedConsole.findByIdAndUpdate(savedConsole._id, {
      $set: chartUpdate,
    });
  }

  // Start the version count (a no-op when the row is gone).
  await SavedConsole.updateOne(
    { _id: savedConsole._id },
    { $set: { version: 1 } },
  );

  // Description + embedding are derived from the committed content,
  // debounced and sha-guarded (apps.md §16.4).
  describeLater(workspaceId, savedConsole._id.toString(), user);
  return savedConsole;
}

/** POST /: create a console at a path (or overwrite a placeholder there). */
export async function createConsoleAtPath(input: {
  workspaceId: string;
  user: SaveActor;
  /** Optional client-provided id. */
  id?: string;
  path: string;
  content: string;
  connectionId?: string;
  /** Backward compatibility. */
  databaseId?: string;
  databaseName?: string;
  folderId?: string;
  description?: string;
  language?: ConsoleLanguage;
  isPrivate?: boolean;
  access?: ConsoleAccessLevel;
  chartSpec?: Record<string, unknown>;
  resultsViewMode?: "table" | "json" | "chart";
}): Promise<SaveResult<Record<string, unknown>>> {
  const { workspaceId, path } = input;
  if (!(await connectionIdAllowed(workspaceId, input.connectionId))) {
    return foreignConnection;
  }
  const targetConnectionId = await connectionOrFirst(
    workspaceId,
    input.connectionId,
  );

  // A different console already at this path is a conflict — unless it only
  // holds placeholder content ("loading..."), which is overwritten in place
  // so no duplicate appears at the path. The client adopts the returned
  // `id`, so it must be that console's.
  const existingConsole = await getConsoleByPath(path, workspaceId);
  const hasRealContent =
    existingConsole?.code &&
    existingConsole.code.trim() !== "" &&
    existingConsole.code !== "loading...";
  let consoleIdToUse = input.id;
  if (existingConsole && existingConsole._id.toString() !== input.id) {
    if (hasRealContent) return pathConflict(existingConsole, path);
    consoleIdToUse = existingConsole._id.toString();
  }

  const savedConsole = await saveAtPath({
    workspaceId,
    user: input.user,
    path,
    content: input.content,
    connectionId: targetConnectionId,
    databaseName: input.databaseName,
    databaseId: input.databaseId,
    options: {
      id: consoleIdToUse,
      folderId: input.folderId,
      description: input.description,
      language: input.language,
      isPrivate: input.isPrivate,
      access: input.access,
    },
    view: {
      chartSpec: input.chartSpec,
      resultsViewMode: input.resultsViewMode,
    },
  });

  return {
    ok: true,
    payload: {
      id: savedConsole._id.toString(),
      path,
      content: input.content,
      connectionId: targetConnectionId,
      databaseName: input.databaseName,
      databaseId: input.databaseId,
      language: savedConsole.language,
    },
  };
}

/** PUT with a path (not an id): explicit user save to a folder. */
export async function saveConsoleByPath(input: {
  workspaceId: string;
  user: SaveActor;
  path: string;
  body: ConsoleSaveBody;
}): Promise<SaveResult<Record<string, unknown>>> {
  const { workspaceId, body } = input;
  if (!(await connectionIdAllowed(workspaceId, body.connectionId))) {
    return foreignConnection;
  }
  const targetConnectionId = await connectionOrFirst(
    workspaceId,
    body.connectionId,
  );
  const savedConsole = await saveAtPath({
    workspaceId,
    user: input.user,
    path: input.path,
    content: body.content,
    connectionId: targetConnectionId,
    databaseName: body.databaseName,
    databaseId: body.databaseId,
    options: {
      folderId: body.folderId,
      description: body.description,
      language: body.language,
      isPrivate: body.isPrivate,
      access: body.access,
    },
  });
  return {
    ok: true,
    payload: {
      id: savedConsole._id.toString(),
      path: input.path,
      content: body.content,
      connectionId: targetConnectionId,
      databaseName: body.databaseName,
      databaseId: body.databaseId,
      language: savedConsole.language,
    },
  };
}

export interface SavedById {
  version: number | undefined;
  draftRevision: number;
  console: { id: string; name: string };
}

function savedById(result: ISavedConsole): SavedById {
  return {
    version: result.version,
    draftRevision: result.draftRevision ?? 1,
    console: { id: result._id.toString(), name: result.name },
  };
}

/**
 * PUT with an id: explicit save (`isSaved: true`, optionally to a new path)
 * or draft autosave, upserting when the console has no row yet.
 */
export async function saveConsoleById(input: {
  workspaceId: string;
  consoleId: string;
  user: SaveActor;
  memberRole: string | undefined;
  body: ConsoleSaveBody;
}): Promise<SaveResult<SavedById>> {
  const { workspaceId, consoleId, user, body } = input;
  const existingById = await SavedConsole.findOne({
    _id: new Types.ObjectId(consoleId),
    workspaceId: new Types.ObjectId(workspaceId),
  });
  // A console that exists only in git (no row yet) is addressed by its
  // derived id. It still has an owner (its path scope) and a language
  // (its extension): the ACL check must run against the file, and the
  // save must replace THAT file — not write a fresh `.sql` beside a
  // `.js`, which is what the row-less defaults did.
  const liveOnly =
    existingById === null
      ? await loadLiveConsoleById(workspaceId, consoleId)
      : null;
  const liveFile = liveOnly && "live" in liveOnly ? liveOnly.live : null;
  const aclSubject: ISavedConsole | null =
    existingById ??
    (liveFile
      ? ({
          _id: liveFile.id,
          workspaceId: new Types.ObjectId(workspaceId),
          access:
            liveFile.location.scope === "private" ? "private" : "workspace",
          isPrivate: liveFile.location.scope === "private",
          owner_id:
            liveFile.location.ownerId || liveFile.row?.owner_id || "git",
          createdBy:
            liveFile.location.ownerId || liveFile.row?.createdBy || "git",
          sharedWith: liveFile.row?.sharedWith,
          workspaceRole: liveFile.row?.workspaceRole,
        } as unknown as ISavedConsole)
      : null);
  if (aclSubject && !canWriteConsole(aclSubject, user.id, input.memberRole)) {
    return {
      ok: false,
      status: 403,
      error: "This console is read-only. Create a copy to make changes.",
    };
  }
  if (!(await connectionIdAllowed(workspaceId, body.connectionId))) {
    return foreignConnection;
  }

  const now = new Date();
  const isExplicitSave = body.isSaved === true;

  // Optimistic concurrency (opt-in): when the client sends the version it
  // loaded, explicit saves only apply while the document still has that
  // version. On mismatch we return 409 version_conflict with the server
  // copy so the user can resolve, instead of silently overwriting another
  // user's save (previously last-write-wins).
  const expectedVersion = counter(body.expectedVersion);
  // Realtime sync (issue #475): `clientId` identifies the writing tab
  // (or `agent:<chatId>`) so subscribers can suppress their own echoes;
  // `expectedDraftRevision` makes draft auto-saves revision-checked so a
  // stale tab cannot silently overwrite a newer draft.
  const clientId =
    typeof body.clientId === "string" ? body.clientId.slice(0, 64) : undefined;
  const expectedDraftRevision = counter(body.expectedDraftRevision);
  const publishConsoleUpdated = (
    doc: ISavedConsole,
    origin: "draft" | "save",
  ) => {
    publishRealtimeEvent(workspaceId, {
      type: "console.updated",
      consoleId: doc._id.toString(),
      draftRevision: doc.draftRevision ?? 1,
      name: doc.name,
      updatedBy: user.id,
      clientId,
      origin,
    });
  };

  const idFilter = {
    _id: new Types.ObjectId(consoleId),
    workspaceId: new Types.ObjectId(workspaceId),
  };
  // Explicit saves are guarded on BOTH counters when the client sent
  // them: `version` catches concurrent explicit saves, `draftRevision`
  // catches everything else that moves the draft (agent modify_console,
  // another tab's autosave) — without it a stale window's Cmd+S passes
  // the version guard and silently reverts those edits. See
  // console-save-guards.ts for the atomic-filter / no-upsert semantics.
  const { filter: guardedFilter, guardActive: saveGuardActive } =
    buildConsoleWriteGuard({
      baseFilter: idFilter,
      docExists: existingById !== null,
      expectedVersion,
      expectedDraftRevision,
    });
  const versionConflict = async (): Promise<SaveResult<SavedById>> => {
    const current = await SavedConsole.findOne(idFilter);
    return {
      ok: false,
      status: 409,
      error: "version_conflict",
      detail: {
        versionConflict: {
          currentVersion: current?.version ?? 1,
          // Both bases are needed to retry an "Overwrite with mine":
          // the retried save must pass BOTH guards.
          currentDraftRevision: current?.draftRevision ?? 1,
          content: current?.code ?? "",
          name: current?.name,
          updatedAt: current?.updatedAt,
        },
      },
    };
  };
  /** The explicit save's commit + guarded write; null when the guard lost. */
  const explicitSave = async (
    setFields: Record<string, unknown>,
    setOnInsertFields: Record<string, unknown>,
    projection: { previousPath?: string | null; message: string },
  ): Promise<SaveResult<SavedById>> => {
    // Git first (apps.md §16.3), then the guarded row write; a lost
    // guard reverts the commit.
    const projected = await projectSavedConsole({
      workspaceId,
      current: existingById ?? null,
      ...(projection.previousPath !== undefined
        ? { previousPath: projection.previousPath }
        : {}),
      set: setFields,
      onInsert: setOnInsertFields,
      actorUserId: user.id,
      message: projection.message,
    });
    setFields.path = projected.path;
    setFields.sourceBlobSha = projected.sourceBlobSha;

    const result = await SavedConsole.findOneAndUpdate(
      guardedFilter,
      {
        $set: setFields,
        $inc: { version: 1, draftRevision: 1 },
        $setOnInsert: setOnInsertFields,
      },
      { upsert: !saveGuardActive, returnDocument: "after" },
    );
    if (!result) {
      await projected.revert();
      return versionConflict();
    }

    publishConsoleUpdated(result as ISavedConsole, "save");
    describeLater(workspaceId, result._id.toString(), user);
    return { ok: true, payload: savedById(result as ISavedConsole) };
  };

  // If this is an explicit save with a path, check for path conflicts
  if (isExplicitSave && body.path) {
    const consolePath = body.path;
    const existingConsole = await getConsoleByPath(consolePath, workspaceId);

    // If a different console exists at this path, return conflict
    if (existingConsole && existingConsole._id.toString() !== consoleId) {
      return pathConflict(existingConsole, consolePath);
    }

    // Parse path to get folder and name
    const parts = consolePath.split("/");
    const consoleName = parts[parts.length - 1];
    let folderId: string | undefined;
    if (parts.length > 1) {
      folderId = await ensureConsoleFolderPath(
        parts.slice(0, -1),
        workspaceId,
        user.id,
      );
    }

    // Update with path information (use upsert in case console hasn't been auto-saved yet)
    const setFields: Record<string, unknown> = {
      code: body.content,
      name: consoleName,
      folderId: folderId ? new Types.ObjectId(folderId) : undefined,
      connectionId: body.connectionId
        ? new Types.ObjectId(body.connectionId)
        : undefined,
      databaseName: body.databaseName,
      databaseId: body.databaseId,
      isSaved: true,
      updatedAt: now,
      // User-initiated write: clears any prior agent origin so a later
      // reconnect doesn't re-surface this as an agent diff.
      lastDraftOrigin: "user",
    };
    if (body.chartSpec !== undefined) setFields.chartSpec = body.chartSpec;
    if (body.resultsViewMode !== undefined) {
      setFields.resultsViewMode = body.resultsViewMode;
    }
    if (body.access !== undefined) {
      setFields.access = body.access;
      setFields.isPrivate = body.access === "private";
    }

    const setOnInsertFields: Record<string, unknown> = {
      createdBy: user.id,
      owner_id: user.id,
      language: liveFile?.location.language ?? ("sql" as const),
      executionCount: 0,
      createdAt: now,
    };
    if (body.access === undefined) {
      setOnInsertFields.isPrivate = true;
      setOnInsertFields.access = "private" as const;
    }

    return explicitSave(setFields, setOnInsertFields, {
      previousPath: liveFile?.path ?? null,
      message: body.comment?.trim() || `save: ${consolePath}`,
    });
  }

  // Build $set object - only include name if title is explicitly provided
  const setFields: Record<string, unknown> = {
    code: body.content,
    connectionId: body.connectionId
      ? new Types.ObjectId(body.connectionId)
      : undefined,
    databaseName: body.databaseName,
    databaseId: body.databaseId,
    updatedAt: now,
    // User-initiated write (autosave / explicit save / agent-edit revert):
    // clears any prior agent origin so reconnect won't re-surface a diff.
    lastDraftOrigin: "user",
  };

  // Only update name if explicitly provided
  if (body.title !== undefined) {
    setFields.name = body.title || "Untitled";
  }

  if (body.chartSpec !== undefined) setFields.chartSpec = body.chartSpec;
  if (body.resultsViewMode !== undefined) {
    setFields.resultsViewMode = body.resultsViewMode;
  }
  if (body.access !== undefined) {
    setFields.access = body.access;
    setFields.isPrivate = body.access === "private";
  }

  // Explicit save without a path (e.g. Cmd+S on an already saved console).
  if (isExplicitSave) {
    setFields.isSaved = true;
    const setOnInsertFields: Record<string, unknown> = {
      createdBy: user.id,
      owner_id: user.id,
      language: "sql" as const,
      executionCount: 0,
      createdAt: now,
    };
    if (body.access === undefined) {
      setOnInsertFields.isPrivate = true;
      setOnInsertFields.access = "private" as const;
    }
    // Only add name to $setOnInsert if not already in $set (avoid MongoDB conflict)
    if (!setFields.name) {
      setOnInsertFields.name = body.title || "Untitled";
    }

    return explicitSave(setFields, setOnInsertFields, {
      message:
        body.comment?.trim() ||
        `save: ${setFields.name ?? existingById?.name ?? "console"}`,
    });
  }

  // Draft auto-save flow: Use upsert to create if doesn't exist.
  //
  // Not `version`-guarded (that counter belongs to explicit saves), but
  // when the client sends `expectedDraftRevision` the write is
  // draft-revision-checked: a stale tab gets 409 draft_conflict instead
  // of overwriting a newer draft (another tab, another user, or the
  // agent). Clients without the field keep legacy last-write-wins.
  const setOnInsertFields: Record<string, unknown> = {
    createdBy: user.id,
    owner_id: user.id,
    language: "sql" as const,
    isPrivate: true,
    access: "private" as const,
    isSaved: false,
    executionCount: 0,
    createdAt: now,
  };
  // Only add name to $setOnInsert if not already in $set (avoid MongoDB conflict)
  if (!setFields.name) {
    setOnInsertFields.name = "Untitled";
  }

  const { filter: draftFilter, guardActive: useDraftGuard } =
    buildConsoleWriteGuard({
      baseFilter: idFilter,
      docExists: existingById !== null,
      // Draft autosaves are deliberately NOT version-guarded (that
      // counter belongs to explicit saves).
      expectedDraftRevision,
    });

  const result = await SavedConsole.findOneAndUpdate(
    draftFilter,
    {
      $set: setFields,
      $inc: { draftRevision: 1 },
      $setOnInsert: setOnInsertFields,
    },
    { upsert: !useDraftGuard, returnDocument: "after" },
  );

  if (!result) {
    const current = await SavedConsole.findOne(idFilter);
    return {
      ok: false,
      status: 409,
      error: "draft_conflict",
      detail: {
        draftConflict: {
          currentDraftRevision: current?.draftRevision ?? 1,
          content: current?.code ?? "",
          name: current?.name,
          updatedAt: current?.updatedAt,
        },
      },
    };
  }

  publishConsoleUpdated(result as ISavedConsole, "draft");
  return { ok: true, payload: savedById(result as ISavedConsole) };
}
