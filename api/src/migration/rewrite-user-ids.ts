/**
 * User-ID Reference-Rewrite Engine (Decision #3: legacy text user IDs -> UUIDv7).
 *
 * Reads the authoritative `legacy_id -> id` mapping from Postgres `users`
 * (`WHERE legacy_id IS NOT NULL AND legacy_id <> id::text`) and idempotently
 * rewrites legacy user IDs (15-char Lucia IDs & legacy UUIDv4 strings) across:
 *   1. MongoDB collections (both Mongo-resident collections such as `flows`,
 *      `dbt_runs.actor`, `notification_rules`, and pre-cutover collections such
 *      as `databaseconnections.writers`, `connectors.{writers,liveReaders,managers}`,
 *      ACL `sharedWith[].userId`, `createdBy`/`ownerId`/`owner_id`/`userId`/`invitedBy`/`savedBy`).
 *   2. Workspace git repository trees (`user:<legacyId>` principals, JSON/YAML
 *      metadata fields like `ownerId`/`owner_id`/`userId`/`createdBy`, and legacy
 *      `users/<legacyId>/` personal folders when present).
 *
 * Dry-run is the default; applying changes requires explicit `dryRun: false`.
 */
import fs from "node:fs";
import path from "node:path";
import { and, isNotNull, ne, sql } from "drizzle-orm";
import type { Collection, Db } from "mongodb";
import { getPgDirectDb, type MakoPgDb } from "../database/pg/client";
import { users } from "../database/pg/schema/auth";
import { migrationRouter, type MigrationRouter } from "./router";
import type { MigrationMode, ResolvedDomainState } from "./types";

export type UserIdMap = ReadonlyMap<string, string>;

export const ALLOWED_APPLY_AUTH_MODES: ReadonlySet<MigrationMode> = new Set([
  "dual_write_pg_read",
  "pg_only",
]);

/**
 * Safety gate before applying user-ID rewrites (`--apply-mongo` / `--apply-git`).
 * Rewriting user IDs while `auth` is still in Stages 1–3 (`mongo_only`,
 * `dual_write_mongo_read`, `dual_write_shadow_compare`) cuts users off from
 * their workspaces and connections because live sessions still carry legacy IDs,
 * and the rewrite has no reverse mode.
 */
export async function assertAuthStageAllowsRewriteApply(
  options: {
    router?: Pick<MigrationRouter, "getState">;
    force?: boolean;
  } = {},
): Promise<ResolvedDomainState> {
  const router = options.router ?? migrationRouter;
  const state = await router.getState("auth");
  if (!ALLOWED_APPLY_AUTH_MODES.has(state.mode) && !options.force) {
    throw new Error(
      `Refusing to apply user-ID rewrites while "auth" domain is in stage "${state.mode}". ` +
        `Advance "auth" to "dual_write_pg_read" (Stage 4) or "pg_only" (Stage 5) first, ` +
        `or pass --force only if you intentionally want to override this safety gate.`,
    );
  }
  return state;
}

/**
 * Load `legacy_id -> uuid` mapping from Postgres `users` for every user whose
 * legacy Mongo `_id` differs from their canonical UUIDv7 `id`.
 */
export async function loadUserLegacyIdMap(
  db: MakoPgDb = getPgDirectDb(),
): Promise<Map<string, string>> {
  const rows = await db
    .select({ legacyId: users.legacyId, id: users.id })
    .from(users)
    .where(
      and(
        isNotNull(users.legacyId),
        ne(users.legacyId, sql`${users.id}::text`),
      ),
    );
  const map = new Map<string, string>();
  for (const row of rows) {
    if (row.legacyId) {
      map.set(row.legacyId, row.id.toLowerCase());
    }
  }
  return map;
}

/** Rewrite an exact bare user ID if present in `map`; returns `null` if unchanged. */
export function rewriteUserIdValue(
  value: unknown,
  map: UserIdMap,
): string | null {
  if (typeof value !== "string" || !value) return null;
  const mapped = map.get(value);
  return mapped && mapped !== value ? mapped : null;
}

/** Rewrite a `user:<id>` principal string if `<id>` is in `map`; returns `null` if unchanged. */
export function rewritePrincipalValue(
  value: unknown,
  map: UserIdMap,
): string | null {
  if (typeof value !== "string" || !value.startsWith("user:")) return null;
  const rawId = value.slice("user:".length);
  const mapped = map.get(rawId);
  return mapped && mapped !== rawId ? `user:${mapped}` : null;
}

/**
 * Rewrite a connection access event writer label (`"user:<id>"` or `"user:<id> schema.table"`).
 * Returns `null` if unchanged.
 */
export function rewriteWriterLabelValue(
  value: unknown,
  map: UserIdMap,
): string | null {
  if (typeof value !== "string" || !value.startsWith("user:")) return null;
  const spaceIdx = value.indexOf(" ");
  const principalPart = spaceIdx === -1 ? value : value.slice(0, spaceIdx);
  const suffix = spaceIdx === -1 ? "" : value.slice(spaceIdx);
  const rewritten = rewritePrincipalValue(principalPart, map);
  return rewritten ? `${rewritten}${suffix}` : null;
}

// ── MongoDB collection rewrite specifications ──────────────────────────────

interface ArrayObjectRule {
  arrayPath: string;
  fields: Array<{
    key: string;
    kind: "userId" | "principal";
  }>;
}

interface StringArrayRule {
  path: string;
  kind: "userId" | "principal" | "writerLabel";
}

interface ScalarFieldRule {
  path: string;
  kind: "userId" | "principal";
}

interface CollectionRewriteSpec {
  collection: string;
  scalars?: ScalarFieldRule[];
  stringArrays?: StringArrayRule[];
  arrayObjects?: ArrayObjectRule[];
}

export const MONGO_USER_ID_REWRITE_SPECS: readonly CollectionRewriteSpec[] = [
  // Connections & access audit
  {
    collection: "databaseconnections",
    scalars: [{ path: "createdBy", kind: "userId" }],
    arrayObjects: [
      {
        arrayPath: "writers",
        fields: [
          { key: "principal", kind: "principal" },
          { key: "addedBy", kind: "userId" },
        ],
      },
    ],
  },
  {
    collection: "connectors",
    scalars: [
      { path: "createdBy", kind: "userId" },
      { path: "keyRequest.requestedBy", kind: "userId" },
    ],
    stringArrays: [{ path: "managers", kind: "userId" }],
    arrayObjects: [
      {
        arrayPath: "writers",
        fields: [
          { key: "principal", kind: "principal" },
          { key: "addedBy", kind: "userId" },
        ],
      },
      {
        arrayPath: "liveReaders",
        fields: [
          { key: "principal", kind: "principal" },
          { key: "addedBy", kind: "userId" },
        ],
      },
    ],
  },
  {
    collection: "connection_access_events",
    scalars: [{ path: "actor", kind: "userId" }],
    stringArrays: [
      { path: "changes.writers.added", kind: "writerLabel" },
      { path: "changes.writers.removed", kind: "writerLabel" },
      { path: "changes.liveReaders.added", kind: "writerLabel" },
      { path: "changes.liveReaders.removed", kind: "writerLabel" },
      { path: "changes.managers.added", kind: "userId" },
      { path: "changes.managers.removed", kind: "userId" },
    ],
  },
  {
    collection: "connection_write_events",
    scalars: [{ path: "principal", kind: "principal" }],
  },
  {
    collection: "connection_verifications",
    scalars: [{ path: "userId", kind: "userId" }],
  },

  // Mongo-resident Flows, Notifications, dbt, GitHub
  {
    collection: "flows",
    scalars: [{ path: "createdBy", kind: "userId" }],
  },
  {
    collection: "notification_rules",
    scalars: [{ path: "createdBy", kind: "userId" }],
  },
  {
    collection: "dbt_projects",
    scalars: [{ path: "createdBy", kind: "userId" }],
    arrayObjects: [
      {
        arrayPath: "environments",
        fields: [{ key: "ownerUserId", kind: "userId" }],
      },
    ],
  },
  {
    collection: "dbt_env_preferences",
    scalars: [{ path: "userId", kind: "userId" }],
  },
  {
    collection: "dbt_jobs",
    scalars: [{ path: "createdBy", kind: "userId" }],
  },
  {
    collection: "dbt_runs",
    scalars: [
      { path: "triggeredBy", kind: "userId" },
      { path: "cancelledBy", kind: "userId" },
      { path: "workingTreeUserId", kind: "userId" },
      { path: "actor.userId", kind: "userId" },
    ],
  },
  {
    collection: "github_installations",
    scalars: [{ path: "createdBy", kind: "userId" }],
  },

  // Workspaces, memberships, invites, handles, OAuth/ACP
  {
    collection: "workspaces",
    scalars: [
      { path: "createdBy", kind: "userId" },
      { path: "appsRepo.linkedBy", kind: "userId" },
    ],
    arrayObjects: [
      {
        arrayPath: "apiKeys",
        fields: [{ key: "createdBy", kind: "userId" }],
      },
      {
        arrayPath: "workspaceRepos",
        fields: [{ key: "linkedBy", kind: "userId" }],
      },
    ],
  },
  {
    collection: "workspacemembers",
    scalars: [{ path: "userId", kind: "userId" }],
  },
  {
    collection: "workspaceinvites",
    scalars: [{ path: "invitedBy", kind: "userId" }],
  },
  {
    collection: "workspace_user_handles",
    scalars: [{ path: "userId", kind: "userId" }],
  },
  {
    collection: "mcpoauthcodes",
    scalars: [{ path: "userId", kind: "userId" }],
  },
  {
    collection: "mcpoauthtokens",
    scalars: [{ path: "userId", kind: "userId" }],
  },
  {
    collection: "mcp_connection_configs",
    scalars: [{ path: "userId", kind: "userId" }],
  },
  {
    collection: "mcp_oauth_flows",
    scalars: [
      { path: "configUserId", kind: "userId" },
      { path: "startedByUserId", kind: "userId" },
    ],
  },
  {
    collection: "acpplangrants",
    scalars: [{ path: "userId", kind: "userId" }],
  },
  {
    collection: "workflow_recorded_writes",
    scalars: [{ path: "userId", kind: "userId" }],
  },
  {
    collection: "realtime_presence",
    scalars: [{ path: "userId", kind: "userId" }],
  },

  // Consoles, notebooks, versions, favourites
  {
    collection: "savedconsoles",
    scalars: [
      { path: "createdBy", kind: "userId" },
      { path: "owner_id", kind: "userId" },
      { path: "publicShare.createdBy", kind: "userId" },
      { path: "lastRun.runBy", kind: "userId" },
    ],
    arrayObjects: [
      {
        arrayPath: "sharedWith",
        fields: [
          { key: "userId", kind: "userId" },
          { key: "addedBy", kind: "userId" },
        ],
      },
    ],
  },
  {
    collection: "consolefolders",
    scalars: [{ path: "ownerId", kind: "userId" }],
  },
  {
    collection: "entity_versions",
    scalars: [{ path: "savedBy", kind: "userId" }],
  },
  {
    collection: "notebookfolders",
    scalars: [{ path: "ownerId", kind: "userId" }],
  },
  {
    collection: "notebookindexes",
    scalars: [{ path: "ownerId", kind: "userId" }],
    arrayObjects: [
      {
        arrayPath: "sharedWith",
        fields: [
          { key: "userId", kind: "userId" },
          { key: "addedBy", kind: "userId" },
        ],
      },
    ],
  },
  {
    collection: "favourites",
    scalars: [{ path: "userId", kind: "userId" }],
  },

  // Apps metadata & usage analytics
  {
    collection: "app_projects",
    scalars: [
      { path: "createdBy", kind: "userId" },
      { path: "owner_id", kind: "userId" },
      { path: "publicShare.createdBy", kind: "userId" },
    ],
    arrayObjects: [
      {
        arrayPath: "sharedWith",
        fields: [
          { key: "userId", kind: "userId" },
          { key: "addedBy", kind: "userId" },
        ],
      },
    ],
  },
  {
    collection: "app_binding_jobs",
    scalars: [
      { path: "actorId", kind: "userId" },
      { path: "userId", kind: "userId" },
    ],
  },
  {
    collection: "app_index",
    scalars: [{ path: "ownerId", kind: "userId" }],
  },
  {
    collection: "app_lifecycle",
    scalars: [
      { path: "verifiedBy", kind: "userId" },
      { path: "restoredBy", kind: "userId" },
    ],
  },
  {
    collection: "app_worktrees",
    scalars: [{ path: "userId", kind: "userId" }],
  },
  {
    collection: "app_usage_daily",
    scalars: [{ path: "userId", kind: "userId" }],
  },
  {
    collection: "app_usage_events",
    scalars: [{ path: "userId", kind: "userId" }],
  },
  {
    collection: "app_feed_snapshots",
    scalars: [{ path: "userId", kind: "userId" }],
  },
  {
    collection: "query_executions",
    scalars: [{ path: "userId", kind: "userId" }],
  },
  {
    collection: "scheduled_query_runs",
    scalars: [{ path: "triggeredBy", kind: "userId" }],
  },
  {
    collection: "llmusages",
    scalars: [{ path: "userId", kind: "userId" }],
  },

  // Chat & MCP
  {
    collection: "chats",
    scalars: [{ path: "createdBy", kind: "userId" }],
  },
  {
    collection: "chatattachments",
    scalars: [{ path: "createdBy", kind: "userId" }],
  },
  {
    collection: "mcp_servers",
    scalars: [{ path: "createdBy", kind: "userId" }],
  },
  {
    collection: "mcp_tool_grants",
    scalars: [{ path: "userId", kind: "userId" }],
  },
];

function getAtPath(obj: Record<string, unknown>, dottedPath: string): unknown {
  const segments = dottedPath.split(".");
  let current: unknown = obj;
  for (const seg of segments) {
    if (current == null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[seg];
  }
  return current;
}

function rewriteByKind(
  value: unknown,
  kind: "userId" | "principal" | "writerLabel",
  map: UserIdMap,
): string | null {
  if (kind === "userId") return rewriteUserIdValue(value, map);
  if (kind === "principal") return rewritePrincipalValue(value, map);
  return rewriteWriterLabelValue(value, map);
}

export interface DocumentUserIdPatch {
  $set: Record<string, unknown>;
  /** Exact original values for every modified path, used for optimistic concurrency guards. */
  filter: Record<string, unknown>;
  fieldsRewritten: number;
}

/**
 * Compute the MongoDB `$set` patch and optimistic-concurrency filter for one
 * document against a `CollectionRewriteSpec`.
 * Returns `null` when nothing in the document requires rewriting (strictly idempotent).
 */
export function computeDocumentUserIdPatch(
  doc: Record<string, unknown>,
  spec: CollectionRewriteSpec,
  map: UserIdMap,
): DocumentUserIdPatch | null {
  const $set: Record<string, unknown> = {};
  const filter: Record<string, unknown> = {};
  let fieldsRewritten = 0;

  for (const rule of spec.scalars ?? []) {
    const raw = getAtPath(doc, rule.path);
    const rewritten = rewriteByKind(raw, rule.kind, map);
    if (rewritten !== null) {
      $set[rule.path] = rewritten;
      filter[rule.path] = raw;
      fieldsRewritten += 1;
    }
  }

  for (const rule of spec.stringArrays ?? []) {
    const raw = getAtPath(doc, rule.path);
    if (!Array.isArray(raw) || raw.length === 0) continue;
    let arrayChanged = false;
    const next = raw.map(entry => {
      const rewritten = rewriteByKind(entry, rule.kind, map);
      if (rewritten !== null) {
        arrayChanged = true;
        fieldsRewritten += 1;
        return rewritten;
      }
      return entry;
    });
    if (arrayChanged) {
      $set[rule.path] = next;
      filter[rule.path] = raw;
    }
  }

  for (const rule of spec.arrayObjects ?? []) {
    const raw = getAtPath(doc, rule.arrayPath);
    if (!Array.isArray(raw) || raw.length === 0) continue;
    let arrayChanged = false;
    const next = raw.map(entry => {
      if (entry == null || typeof entry !== "object") return entry;
      const item = entry as Record<string, unknown>;
      let itemChanged = false;
      const cloned: Record<string, unknown> = { ...item };
      for (const field of rule.fields) {
        const rewritten = rewriteByKind(item[field.key], field.kind, map);
        if (rewritten !== null) {
          cloned[field.key] = rewritten;
          itemChanged = true;
          arrayChanged = true;
          fieldsRewritten += 1;
        }
      }
      return itemChanged ? cloned : entry;
    });
    if (arrayChanged) {
      $set[rule.arrayPath] = next;
      filter[rule.arrayPath] = raw;
    }
  }

  return fieldsRewritten > 0 ? { $set, filter, fieldsRewritten } : null;
}

export interface RewriteConflictEntry {
  collection: string;
  docId: string;
  kind: "duplicate_key" | "concurrent_modification";
  resolution:
    | "merged_and_deleted"
    | "deleted_duplicate"
    | "resolved_in_place"
    | "skipped";
  message: string;
}

export interface CollectionRewriteReport {
  collection: string;
  scannedDocs: number;
  matchedDocs: number;
  modifiedDocs: number;
  fieldsRewritten: number;
  conflictsResolved: number;
  conflictsSkipped: number;
  conflicts: RewriteConflictEntry[];
}

export interface MongoRewriteReport {
  dryRun: boolean;
  mappedUsers: number;
  collections: CollectionRewriteReport[];
  totalScannedDocs: number;
  totalMatchedDocs: number;
  totalModifiedDocs: number;
  totalFieldsRewritten: number;
  totalConflictsResolved: number;
  totalConflictsSkipped: number;
  conflicts: RewriteConflictEntry[];
}

export interface RewriteMongoUserIdsOptions {
  mongoDb: Db;
  userIdMap: UserIdMap;
  dryRun?: boolean;
  /** Optional subset of collection names to process. Unknown names throw an error. */
  collections?: readonly string[];
  /** Maximum guarded retry attempts per document on concurrent modification (default: 5). */
  maxRetriesPerDoc?: number;
  /** Optional hook invoked right before each guarded write (useful for deterministic concurrency tests). */
  beforeDocUpdate?: (info: {
    collection: string;
    docId: unknown;
    attempt: number;
  }) => Promise<void> | void;
}

const DEFAULT_MAX_RETRIES_PER_DOC = 5;

const WORKSPACE_MEMBER_ROLE_RANK: Record<string, number> = {
  viewer: 1,
  member: 2,
  admin: 3,
  owner: 4,
};

function isDuplicateKeyError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const err = error as { code?: unknown; codeName?: unknown };
  return err.code === 11000 || err.codeName === "DuplicateKey";
}

function unwrapFindOneAndDeleteDoc(
  result: unknown,
): Record<string, unknown> | null {
  if (!result || typeof result !== "object") return null;
  if ("value" in result && !("_id" in result)) {
    const v = (result as { value: unknown }).value;
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  }
  return result as Record<string, unknown>;
}

async function resolveDuplicateKeyConflict(
  col: Collection,
  collectionName: string,
  currentDoc: Record<string, unknown>,
  patch: DocumentUserIdPatch,
  guardedFilter: Record<string, unknown>,
  error: unknown,
): Promise<RewriteConflictEntry | "retry"> {
  const errMsg = error instanceof Error ? error.message : String(error);
  const mappedUserId =
    typeof patch.$set.userId === "string" ? patch.$set.userId : null;

  if (collectionName === "app_usage_daily" && mappedUserId) {
    // Atomically claim the legacy rollup row so counters are never double-counted,
    // then merge its counters & timestamps into the existing UUIDv7 rollup row.
    const claimedRaw = await col.findOneAndDelete(guardedFilter);
    const claimed = unwrapFindOneAndDeleteDoc(claimedRaw);
    if (!claimed) return "retry";

    const $inc: Record<string, number> = {};
    if (typeof claimed.opens === "number" && claimed.opens !== 0) {
      $inc.opens = claimed.opens;
    }
    if (
      typeof claimed.activeSeconds === "number" &&
      claimed.activeSeconds !== 0
    ) {
      $inc.activeSeconds = claimed.activeSeconds;
    }
    const sources = claimed.sources as Record<string, unknown> | undefined;
    if (sources && typeof sources === "object") {
      for (const sourceKey of ["app", "share", "embed"] as const) {
        const val = sources[sourceKey];
        if (typeof val === "number" && val !== 0) {
          $inc[`sources.${sourceKey}`] = val;
        }
      }
    }

    const mergeUpdate: Record<string, unknown> = {
      $setOnInsert: {
        workspaceId: claimed.workspaceId,
        appId: claimed.appId,
        userId: mappedUserId,
        day: claimed.day,
      },
    };
    if (Object.keys($inc).length > 0) {
      mergeUpdate.$inc = $inc;
    }
    if (claimed.firstAt instanceof Date) {
      mergeUpdate.$min = { firstAt: claimed.firstAt };
    }
    if (claimed.lastAt instanceof Date) {
      mergeUpdate.$max = { lastAt: claimed.lastAt };
    }

    await col.updateOne(
      {
        workspaceId: claimed.workspaceId,
        appId: claimed.appId,
        userId: mappedUserId,
        day: claimed.day,
      },
      mergeUpdate,
      { upsert: true },
    );

    return {
      collection: collectionName,
      docId: String(currentDoc._id),
      kind: "duplicate_key",
      resolution: "merged_and_deleted",
      message: `Merged duplicate app_usage_daily counters into UUIDv7 row (${mappedUserId}) and removed legacy duplicate (${errMsg})`,
    };
  }

  if (collectionName === "workspacemembers" && mappedUserId) {
    const existingSameWs = (await col.findOne({
      workspaceId: currentDoc.workspaceId,
      userId: mappedUserId,
    })) as Record<string, unknown> | null;

    if (existingSameWs) {
      const claimedRaw = await col.findOneAndDelete(guardedFilter);
      const claimed = unwrapFindOneAndDeleteDoc(claimedRaw);
      if (!claimed) return "retry";

      const mergeOps: Record<string, unknown> = {};
      const $set: Record<string, unknown> = {};
      const legacyRank =
        typeof claimed.role === "string"
          ? (WORKSPACE_MEMBER_ROLE_RANK[claimed.role] ?? 0)
          : 0;
      const existingRank =
        typeof existingSameWs.role === "string"
          ? (WORKSPACE_MEMBER_ROLE_RANK[existingSameWs.role] ?? 0)
          : 0;
      if (legacyRank > existingRank && typeof claimed.role === "string") {
        $set.role = claimed.role;
      }
      if (
        claimed.isDefaultMembership === true &&
        existingSameWs.isDefaultMembership !== true
      ) {
        const anotherDefault = await col.findOne({
          userId: mappedUserId,
          isDefaultMembership: true,
        });
        if (!anotherDefault) {
          $set.isDefaultMembership = true;
        }
      }
      if (Object.keys($set).length > 0) {
        mergeOps.$set = $set;
      }
      if (claimed.joinedAt instanceof Date) {
        mergeOps.$min = { joinedAt: claimed.joinedAt };
      }
      if (Object.keys(mergeOps).length > 0) {
        await col.updateOne({ _id: existingSameWs._id as never }, mergeOps);
      }

      return {
        collection: collectionName,
        docId: String(currentDoc._id),
        kind: "duplicate_key",
        resolution: "merged_and_deleted",
        message: `Merged duplicate workspacemembers row into existing UUIDv7 membership (${mappedUserId}) and removed legacy duplicate (${errMsg})`,
      };
    }

    if (currentDoc.isDefaultMembership === true) {
      // Collision was on the partial unique index `{ userId, isDefaultMembership: true }`
      // across a different workspace. Preserve membership in this workspace by unsetting
      // `isDefaultMembership` while rewriting `userId`.
      try {
        const res = await col.updateOne(guardedFilter, {
          $set: patch.$set,
          $unset: { isDefaultMembership: "" },
        });
        if (res.matchedCount === 0) return "retry";
        return {
          collection: collectionName,
          docId: String(currentDoc._id),
          kind: "duplicate_key",
          resolution: "resolved_in_place",
          message: `Resolved partial unique default-membership collision by unsetting isDefaultMembership while rewriting userId to ${mappedUserId}`,
        };
      } catch (innerErr) {
        if (isDuplicateKeyError(innerErr)) {
          return "retry";
        }
        throw innerErr;
      }
    }
  }

  // Default conflict resolution for live unique-indexed collections (e.g.
  // `app_worktrees`, `workspace_user_handles`, `dbt_env_preferences`,
  // `mcp_connection_configs`, `favourites`): a live UUIDv7 row already exists,
  // so remove the stale legacy duplicate guarded by the snapshot filter.
  const del = await col.deleteOne(guardedFilter);
  if (del.deletedCount === 0) return "retry";

  return {
    collection: collectionName,
    docId: String(currentDoc._id),
    kind: "duplicate_key",
    resolution: "deleted_duplicate",
    message: `Deleted stale legacy duplicate in ${collectionName} after E11000 conflict with existing UUIDv7 row (${errMsg})`,
  };
}

const KNOWN_REWRITE_COLLECTIONS = new Set(
  MONGO_USER_ID_REWRITE_SPECS.map(spec => spec.collection),
);

/**
 * Validate a caller-supplied `--collections` filter against `MONGO_USER_ID_REWRITE_SPECS`.
 * Throws an explicit error if any collection name is unknown so typos never
 * silently report 0 matches and exit 0.
 */
export function validateRewriteCollections(
  collections: readonly string[],
): Set<string> {
  const unknown = [
    ...new Set(
      collections.filter(name => !KNOWN_REWRITE_COLLECTIONS.has(name)),
    ),
  ];
  if (unknown.length > 0) {
    throw new Error(
      `Unknown --collections name(s): ${unknown.join(", ")}. ` +
        `Supported collections (${MONGO_USER_ID_REWRITE_SPECS.length}): ` +
        MONGO_USER_ID_REWRITE_SPECS.map(s => s.collection).join(", "),
    );
  }
  return new Set(collections);
}

/**
 * Scan and optionally rewrite legacy user IDs across all MongoDB collections.
 * Safe by default (`dryRun: true`), concurrency-guarded against live writes,
 * resilient to per-doc E11000 duplicate-key collisions, and idempotent across
 * repeat executions.
 */
export async function rewriteMongoUserIds(
  options: RewriteMongoUserIdsOptions,
): Promise<MongoRewriteReport> {
  const dryRun = options.dryRun ?? true;
  const maxRetries = Math.max(
    1,
    options.maxRetriesPerDoc ?? DEFAULT_MAX_RETRIES_PER_DOC,
  );
  const { mongoDb, userIdMap } = options;

  const filterSet = options.collections
    ? validateRewriteCollections(options.collections)
    : null;

  const existingCols = new Set(
    (await mongoDb.listCollections({}, { nameOnly: true }).toArray()).map(
      c => c.name,
    ),
  );

  const specs = MONGO_USER_ID_REWRITE_SPECS.filter(
    spec =>
      existingCols.has(spec.collection) &&
      (!filterSet || filterSet.has(spec.collection)),
  );

  const reports: CollectionRewriteReport[] = [];
  const allConflicts: RewriteConflictEntry[] = [];
  let totalScannedDocs = 0;
  let totalMatchedDocs = 0;
  let totalModifiedDocs = 0;
  let totalFieldsRewritten = 0;
  let totalConflictsResolved = 0;
  let totalConflictsSkipped = 0;

  if (userIdMap.size === 0) {
    return {
      dryRun,
      mappedUsers: 0,
      collections: [],
      totalScannedDocs: 0,
      totalMatchedDocs: 0,
      totalModifiedDocs: 0,
      totalFieldsRewritten: 0,
      totalConflictsResolved: 0,
      totalConflictsSkipped: 0,
      conflicts: [],
    };
  }

  for (const spec of specs) {
    const col = mongoDb.collection(spec.collection);
    const cursor = col.find({});
    let scannedDocs = 0;
    let matchedDocs = 0;
    let modifiedDocs = 0;
    let fieldsRewritten = 0;
    let conflictsResolved = 0;
    let conflictsSkipped = 0;
    const colConflicts: RewriteConflictEntry[] = [];

    for await (const rawDoc of cursor) {
      scannedDocs += 1;
      const doc = rawDoc as Record<string, unknown>;
      const initialPatch = computeDocumentUserIdPatch(doc, spec, userIdMap);
      if (!initialPatch) continue;

      matchedDocs += 1;

      if (dryRun) {
        fieldsRewritten += initialPatch.fieldsRewritten;
        continue;
      }

      let currentDoc = doc;
      let currentPatch: DocumentUserIdPatch | null = initialPatch;
      let resolved = false;

      for (let attempt = 0; attempt < maxRetries; attempt += 1) {
        if (options.beforeDocUpdate) {
          await options.beforeDocUpdate({
            collection: spec.collection,
            docId: currentDoc._id,
            attempt,
          });
        }

        const guardedFilter: Record<string, unknown> = {
          _id: currentDoc._id,
          ...currentPatch.filter,
        };

        try {
          const res = await col.updateOne(guardedFilter, {
            $set: currentPatch.$set,
          });
          if (res.matchedCount > 0) {
            modifiedDocs += res.modifiedCount;
            fieldsRewritten += currentPatch.fieldsRewritten;
            resolved = true;
            break;
          }
        } catch (error) {
          if (!isDuplicateKeyError(error)) {
            throw error;
          }
          const conflictOutcome = await resolveDuplicateKeyConflict(
            col,
            spec.collection,
            currentDoc,
            currentPatch,
            guardedFilter,
            error,
          );
          if (conflictOutcome !== "retry") {
            conflictsResolved += 1;
            modifiedDocs += 1;
            fieldsRewritten += currentPatch.fieldsRewritten;
            colConflicts.push(conflictOutcome);
            allConflicts.push(conflictOutcome);
            resolved = true;
            break;
          }
        }

        // Guarded update did not match (concurrent edit): re-read the live
        // document and recompute the patch so concurrent changes are preserved.
        const latest = (await col.findOne({
          _id: currentDoc._id as never,
        })) as Record<string, unknown> | null;
        if (!latest) {
          resolved = true;
          break;
        }
        currentDoc = latest;
        currentPatch = computeDocumentUserIdPatch(latest, spec, userIdMap);
        if (!currentPatch) {
          resolved = true;
          break;
        }
      }

      if (!resolved) {
        const skippedEntry: RewriteConflictEntry = {
          collection: spec.collection,
          docId: String(currentDoc._id),
          kind: "concurrent_modification",
          resolution: "skipped",
          message: `Skipped ${spec.collection} doc ${String(currentDoc._id)} after ${maxRetries} concurrent-modification retries; re-run to complete`,
        };
        conflictsSkipped += 1;
        colConflicts.push(skippedEntry);
        allConflicts.push(skippedEntry);
      }
    }

    if (scannedDocs > 0 || matchedDocs > 0) {
      reports.push({
        collection: spec.collection,
        scannedDocs,
        matchedDocs,
        modifiedDocs,
        fieldsRewritten,
        conflictsResolved,
        conflictsSkipped,
        conflicts: colConflicts,
      });
    }
    totalScannedDocs += scannedDocs;
    totalMatchedDocs += matchedDocs;
    totalModifiedDocs += modifiedDocs;
    totalFieldsRewritten += fieldsRewritten;
    totalConflictsResolved += conflictsResolved;
    totalConflictsSkipped += conflictsSkipped;
  }

  return {
    dryRun,
    mappedUsers: userIdMap.size,
    collections: reports,
    totalScannedDocs,
    totalMatchedDocs,
    totalModifiedDocs,
    totalFieldsRewritten,
    totalConflictsResolved,
    totalConflictsSkipped,
    conflicts: allConflicts,
  };
}

// ── Workspace git directory rewriter ───────────────────────────────────────

const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  ".next",
  "dist",
  "build",
  ".turbo",
]);

const BINARY_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".pdf",
  ".parquet",
  ".zip",
  ".gz",
  ".tar",
  ".wasm",
  ".woff",
  ".woff2",
  ".ttf",
  ".eot",
  ".mp4",
  ".mp3",
  ".bin",
]);

const MAX_TEXT_FILE_BYTES = 5 * 1024 * 1024;

const METADATA_USER_KEYS = [
  "ownerId",
  "owner_id",
  "userId",
  "user_id",
  "createdBy",
  "created_by",
  "ownerUserId",
  "owner_user_id",
  "addedBy",
  "added_by",
  "invitedBy",
  "invited_by",
  "savedBy",
  "saved_by",
  "verifiedBy",
  "verified_by",
  "restoredBy",
  "restored_by",
  "actorId",
  "actor_id",
  "configUserId",
  "startedByUserId",
  "runBy",
  "run_by",
  "linkedBy",
  "linked_by",
].join("|");

const PRINCIPAL_RE = /\buser:([A-Za-z0-9_-]{8,64})(?![A-Za-z0-9_-])/g;
const JSON_METADATA_RE = new RegExp(
  `("(?:${METADATA_USER_KEYS})"\\s*:\\s*")([A-Za-z0-9_-]{8,64})(")`,
  "g",
);
const YAML_METADATA_RE = new RegExp(
  `((?:^|[\\r\\n])[ \\t]*(?:-[ \\t]+)?(?:${METADATA_USER_KEYS})\\s*:\\s*["']?)([A-Za-z0-9_-]{8,64})(["']?(?=[ \\t]*(?:#[^\\r\\n]*)?(?:\\r?\\n|$)))`,
  "g",
);

/**
 * Rewrite `user:<legacyId>` principals and structured JSON/YAML user-ID metadata
 * fields inside a text file. Pure and idempotent.
 */
export function rewriteTextFileUserIds(
  content: string,
  map: UserIdMap,
): { content: string; replacements: number } {
  if (map.size === 0 || !content) {
    return { content, replacements: 0 };
  }

  let replacements = 0;

  let next = content.replace(PRINCIPAL_RE, (full, rawId: string) => {
    const mapped = map.get(rawId);
    if (!mapped || mapped === rawId) return full;
    replacements += 1;
    return `user:${mapped}`;
  });

  next = next.replace(
    JSON_METADATA_RE,
    (full, prefix: string, rawId: string, suffix: string) => {
      const mapped = map.get(rawId);
      if (!mapped || mapped === rawId) return full;
      replacements += 1;
      return `${prefix}${mapped}${suffix}`;
    },
  );

  next = next.replace(
    YAML_METADATA_RE,
    (full, prefix: string, rawId: string, suffix: string) => {
      const mapped = map.get(rawId);
      if (!mapped || mapped === rawId) return full;
      replacements += 1;
      return `${prefix}${mapped}${suffix}`;
    },
  );

  return { content: next, replacements };
}

export interface GitFileRewriteEntry {
  relativePath: string;
  replacements: number;
}

export interface GitDirRenameEntry {
  from: string;
  to: string;
}

export interface GitRewriteReport {
  repoDir: string;
  dryRun: boolean;
  mappedUsers: number;
  filesScanned: number;
  filesMatched: number;
  filesModified: number;
  totalReplacements: number;
  files: GitFileRewriteEntry[];
  directoryRenames: GitDirRenameEntry[];
}

export interface RewriteGitUserIdsOptions {
  repoDir: string;
  userIdMap: UserIdMap;
  dryRun?: boolean;
}

function isProbablyBinary(buf: Buffer): boolean {
  const sampleLen = Math.min(buf.length, 4096);
  for (let i = 0; i < sampleLen; i += 1) {
    if (buf[i] === 0) return true;
  }
  return false;
}

/**
 * Scan and optionally rewrite legacy user IDs in a workspace git working directory.
 * Safe by default (`dryRun: true`) and strictly idempotent.
 */
export async function rewriteGitUserIds(
  options: RewriteGitUserIdsOptions,
): Promise<GitRewriteReport> {
  const dryRun = options.dryRun ?? true;
  const repoDir = path.resolve(options.repoDir);
  const { userIdMap } = options;

  if (!fs.existsSync(repoDir) || !fs.statSync(repoDir).isDirectory()) {
    throw new Error(`Git directory does not exist: ${repoDir}`);
  }

  let filesScanned = 0;
  let filesMatched = 0;
  let filesModified = 0;
  let totalReplacements = 0;
  const files: GitFileRewriteEntry[] = [];
  const directoryRenames: GitDirRenameEntry[] = [];

  if (userIdMap.size === 0) {
    return {
      repoDir,
      dryRun,
      mappedUsers: 0,
      filesScanned: 0,
      filesMatched: 0,
      filesModified: 0,
      totalReplacements: 0,
      files: [],
      directoryRenames: [],
    };
  }

  const walk = (dir: string): void => {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        walk(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;

      const ext = path.extname(entry.name).toLowerCase();
      if (BINARY_EXTENSIONS.has(ext)) continue;

      const stat = fs.statSync(fullPath);
      if (stat.size === 0 || stat.size > MAX_TEXT_FILE_BYTES) continue;

      const rawBuf = fs.readFileSync(fullPath);
      if (isProbablyBinary(rawBuf)) continue;

      filesScanned += 1;
      const original = rawBuf.toString("utf8");
      const { content, replacements } = rewriteTextFileUserIds(
        original,
        userIdMap,
      );
      if (replacements === 0) continue;

      filesMatched += 1;
      totalReplacements += replacements;
      files.push({
        relativePath: path
          .relative(repoDir, fullPath)
          .split(path.sep)
          .join("/"),
        replacements,
      });

      if (!dryRun) {
        fs.writeFileSync(fullPath, content, "utf8");
        filesModified += 1;
      }
    }
  };

  walk(repoDir);

  // Also check for legacy `users/<legacyId>/` directories (pre-handle personal folders)
  const usersDir = path.join(repoDir, "users");
  if (fs.existsSync(usersDir) && fs.statSync(usersDir).isDirectory()) {
    for (const entry of fs.readdirSync(usersDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const mapped = userIdMap.get(entry.name);
      if (!mapped || mapped === entry.name) continue;
      const targetPath = path.join(usersDir, mapped);
      if (fs.existsSync(targetPath)) continue;
      directoryRenames.push({
        from: `users/${entry.name}`,
        to: `users/${mapped}`,
      });
      if (!dryRun) {
        fs.renameSync(path.join(usersDir, entry.name), targetPath);
      }
    }
  }

  return {
    repoDir,
    dryRun,
    mappedUsers: userIdMap.size,
    filesScanned,
    filesMatched,
    filesModified,
    totalReplacements,
    files,
    directoryRenames,
  };
}
