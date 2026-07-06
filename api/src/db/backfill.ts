/* eslint-disable no-console, no-process-exit */
/**
 * Repeatable ETL that copies Mako's metadata from MongoDB into the Postgres
 * (Drizzle) store, using the deterministic ObjectId -> uuid mapping so
 * cross-document references resolve without a lookup table.
 *
 * Convergent by design (this is the big-bang cutover tool): every row is
 * **upserted** (`onConflictDoUpdate` on the primary key), so re-running the
 * backfill repairs any drift accumulated since the previous run — updates in
 * Mongo overwrite stale Postgres rows. With `--prune`, rows that no longer
 * exist in Mongo are also deleted from Postgres, making the run a full
 * reconciliation. The intended cutover sequence is:
 *
 *   1. freeze writes (maintenance window)
 *   2. run `db:backfill --prune`
 *   3. run `db:verify` (non-zero exit blocks the flip)
 *   4. flip the persistence flags and deploy
 *
 * Usage:
 *   BACKFILL_MONGO_URL=<mongo uri> POSTGRES_URL=<pg uri> \
 *     tsx src/db/backfill.ts [--domains=auth,workspaces,connections,consoles,chats,queries] [--prune]
 *
 * Connection/connector credential blobs are copied as-is (still ciphertext from
 * Mongo); they decrypt with the same ENCRYPTION_KEY via the repositories.
 */
import fs from "node:fs";
import path from "node:path";

import dotenv from "dotenv";
import { inArray } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import mongoose from "mongoose";

// Root .env for local runs; explicit env vars take precedence (dotenv does
// not override existing values).
const envPath = path.resolve(__dirname, "../../../.env");
if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath });
}

import {
  EmailVerification,
  LlmUsage,
  OAuthAccount,
  Session,
  User,
} from "../database/schema";
import {
  Chat,
  ChatAttachment,
  ConsoleFolder,
  Connector,
  DatabaseConnection,
  QueryExecution,
  SavedConsole,
  Workspace,
  WorkspaceInvite,
  WorkspaceMember,
} from "../database/workspace-schema";
import { loggers } from "../logging";
import { closePostgres, getDb } from "./client";
import { toPgId, toPgIdOrNull } from "./ids";
import { runMigrations } from "./migrate";
import {
  chatAttachments,
  chats,
  connectors,
  consoleFolders,
  databaseConnections,
  emailVerifications,
  llmUsage,
  oauthAccounts,
  queryExecutions,
  savedConsoles,
  sessions,
  users,
  workspaceInvites,
  workspaceMembers,
  workspaces,
} from "./schema";

const log = loggers.migration();

type Counts = { upserted: number; failed: number };

function newCounts(): Counts {
  return { upserted: 0, failed: 0 };
}

/**
 * Upsert one row, swallowing per-row errors so one bad doc never aborts the
 * run. On conflict every non-key column is overwritten with the Mongo value,
 * so re-running the backfill converges Postgres onto Mongo (repairs drift).
 */
async function upsertRow(
  table: any,
  values: Record<string, unknown>,
  counts: Counts,
  label: string,
  conflictTarget?: unknown[],
): Promise<void> {
  try {
    const target = conflictTarget ?? [table.id];
    const targetNames = new Set(
      (target as Array<{ name?: string }>).map(c => String(c.name)),
    );
    const set: Record<string, unknown> = {};
    for (const key of Object.keys(values)) {
      const column = table[key] as { name?: string } | undefined;
      if (!column || targetNames.has(String(column.name))) continue;
      set[key] = values[key];
    }
    const insert = getDb().insert(table).values(values);
    await (Object.keys(set).length > 0
      ? insert.onConflictDoUpdate({ target: target as never, set })
      : insert.onConflictDoNothing());
    counts.upserted++;
  } catch (err) {
    counts.failed++;
    if (counts.failed <= 3) {
      const cause = (err as { cause?: { detail?: string; message?: string } })
        .cause;
      log.warn(`backfill ${label} row failed`, {
        error: err instanceof Error ? err.message : String(err),
        detail: cause?.detail ?? cause?.message,
        id: values.id,
      });
    }
  }
}

let pruneEnabled = false;

/**
 * `--prune`: delete Postgres rows whose primary key no longer maps to a Mongo
 * document. Run after the domain's upserts so the run is a full reconciliation
 * (Mongo deletes propagate). Chunked `IN` deletes; FK `cascade`/`set null`
 * rules on the schema handle dependents.
 */
async function pruneTable(
  table: PgTable & { id: any },
  mongoIds: Iterable<unknown>,
  label: string,
  mapId: (id: unknown) => string = id => toPgId(String(id)),
): Promise<void> {
  if (!pruneEnabled) return;
  const keep = new Set<string>();
  for (const id of mongoIds) keep.add(mapId(id));

  const db = getDb();
  const existing = await db.select({ id: table.id }).from(table as never);
  const stale = (existing as Array<{ id: string }>)
    .map(r => String(r.id))
    .filter(id => !keep.has(id));
  for (let i = 0; i < stale.length; i += 500) {
    await db.delete(table).where(inArray(table.id, stale.slice(i, i + 500)));
  }
  if (stale.length > 0) {
    log.info(`backfill prune ${label}`, { deleted: stale.length });
  }
}

function asDate(v: unknown): Date | undefined {
  if (v instanceof Date) return v;
  if (typeof v === "string" || typeof v === "number") {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? undefined : d;
  }
  return undefined;
}

function num(v: unknown): number | undefined {
  if (typeof v === "number") return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isNaN(n) ? undefined : n;
  }
  return undefined;
}

/** Load the set of existing primary keys for a table (to null dangling refs). */
async function loadIdSet(table: { id: any }): Promise<Set<string>> {
  const rows = await getDb()
    .select({ id: table.id })
    .from(table as any);
  return new Set(rows.map(r => String(r.id)));
}

/** Map a Mongo ref to its uuid, or null if the target row is absent in PG. */
function refOrNull(value: unknown, existing: Set<string>): string | null {
  const mapped = toPgIdOrNull(value ? String(value) : null);
  if (mapped === null) return null;
  return existing.has(mapped) ? mapped : null;
}

// ---- domain backfills ----

async function backfillAuth(): Promise<void> {
  const uc = newCounts();
  const userDocs = await User.find().lean();
  for (const u of userDocs) {
    await upsertRow(
      users,
      {
        id: toPgId(String(u._id)),
        email: String(u.email).toLowerCase(),
        hashedPassword: u.hashedPassword ?? null,
        emailVerified: u.emailVerified ?? false,
        onboarding: u.onboarding ?? null,
        createdAt: asDate(u.createdAt),
        updatedAt: asDate(u.updatedAt),
      },
      uc,
      "user",
    );
  }
  log.info("backfill users", uc);

  const sc = newCounts();
  const sessionDocs = await Session.find().lean();
  for (const s of sessionDocs) {
    await upsertRow(
      sessions,
      {
        id: String(s._id),
        userId: toPgId(String(s.userId)),
        expiresAt: asDate(s.expiresAt) ?? new Date(),
        activeWorkspaceId: toPgIdOrNull(s.activeWorkspaceId),
      },
      sc,
      "session",
    );
  }
  log.info("backfill sessions", sc);

  const oc = newCounts();
  const oauthDocs = await OAuthAccount.find().lean();
  for (const o of oauthDocs) {
    await upsertRow(
      oauthAccounts,
      {
        id: toPgId(String(o._id)),
        userId: toPgId(String(o.userId)),
        provider: o.provider,
        providerUserId: o.providerUserId,
        email: o.email ?? null,
        createdAt: asDate(o.createdAt),
      },
      oc,
      "oauth_account",
    );
  }
  log.info("backfill oauth_accounts", oc);

  const ec = newCounts();
  const verificationDocs = await EmailVerification.find().lean();
  for (const e of verificationDocs) {
    await upsertRow(
      emailVerifications,
      {
        id: toPgId(String(e._id)),
        email: String(e.email).toLowerCase(),
        code: e.code,
        type: e.type,
        expiresAt: asDate(e.expiresAt) ?? new Date(),
        createdAt: asDate(e.createdAt),
      },
      ec,
      "email_verification",
    );
  }
  log.info("backfill email_verifications", ec);

  // Prune leaf tables before their referenced parents.
  await pruneTable(
    emailVerifications,
    verificationDocs.map(e => e._id),
    "email_verifications",
  );
  await pruneTable(
    oauthAccounts,
    oauthDocs.map(o => o._id),
    "oauth_accounts",
  );
  await pruneTable(
    sessions,
    sessionDocs.map(s => s._id),
    "sessions",
    id => String(id),
  );
  await pruneTable(
    users,
    userDocs.map(u => u._id),
    "users",
  );
}

async function backfillWorkspaces(): Promise<void> {
  const { workspaceApiKeys } = await import("./schema");
  const wc = newCounts();
  const akc = newCounts();
  const workspaceDocs = await Workspace.find().lean();
  const apiKeyIds: string[] = [];
  for (const w of workspaceDocs) {
    await upsertRow(
      workspaces,
      {
        id: toPgId(String(w._id)),
        name: w.name,
        slug: String(w.slug).toLowerCase(),
        createdBy: toPgId(String(w.createdBy)),
        settings: w.settings ?? null,
        billing: w.billing ?? null,
        selfDirective: w.selfDirective ?? "",
        createdAt: asDate(w.createdAt),
        updatedAt: asDate(w.updatedAt),
      },
      wc,
      "workspace",
    );
    for (const k of (w as { apiKeys?: any[] }).apiKeys ?? []) {
      if (!k._id) {
        // No stable identity to upsert on; skip rather than duplicate on rerun.
        akc.failed++;
        continue;
      }
      apiKeyIds.push(String(k._id));
      await upsertRow(
        workspaceApiKeys,
        {
          id: toPgId(String(k._id)),
          workspaceId: toPgId(String(w._id)),
          name: k.name,
          keyHash: k.keyHash,
          prefix: k.prefix,
          createdBy: toPgIdOrNull(k.createdBy),
          lastUsedAt: asDate(k.lastUsedAt),
          createdAt: asDate(k.createdAt),
        },
        akc,
        "workspace_api_key",
      );
    }
  }
  log.info("backfill workspaces", wc);
  log.info("backfill workspace_api_keys", akc);

  const mc = newCounts();
  const memberDocs = await WorkspaceMember.find().lean();
  for (const m of memberDocs) {
    await upsertRow(
      workspaceMembers,
      {
        id: toPgId(String(m._id)),
        workspaceId: toPgId(String(m.workspaceId)),
        userId: toPgId(String(m.userId)),
        role: m.role,
        isDefaultMembership: m.isDefaultMembership ?? null,
        joinedAt: asDate(m.joinedAt),
      },
      mc,
      "workspace_member",
      // Converge on the natural key: a previous run without explicit ids may
      // have stored a random uuid for the same membership.
      [workspaceMembers.workspaceId, workspaceMembers.userId],
    );
  }
  log.info("backfill workspace_members", mc);

  const ic = newCounts();
  const inviteDocs = await WorkspaceInvite.find().lean();
  for (const invDoc of inviteDocs) {
    const inv = invDoc as Record<string, any>;
    await upsertRow(
      workspaceInvites,
      {
        id: toPgId(String(inv._id)),
        workspaceId: toPgId(String(inv.workspaceId)),
        email: String(inv.email).toLowerCase(),
        token: inv.token,
        role: inv.role,
        invitedBy: toPgId(String(inv.invitedBy)),
        expiresAt: asDate(inv.expiresAt) ?? new Date(),
        acceptedAt: asDate(inv.acceptedAt),
        createdAt: asDate(inv.createdAt),
      },
      ic,
      "workspace_invite",
    );
  }
  log.info("backfill workspace_invites", ic);

  await pruneTable(
    workspaceInvites,
    inviteDocs.map(i => i._id),
    "workspace_invites",
  );
  await pruneTable(workspaceApiKeys, apiKeyIds, "workspace_api_keys");
  // Members may carry legacy random uuids (pre-deterministic-id runs); prune
  // by natural key instead of primary key.
  await pruneMembersByNaturalKey(memberDocs);
  await pruneTable(
    workspaces,
    workspaceDocs.map(w => w._id),
    "workspaces",
  );
}

async function pruneMembersByNaturalKey(
  memberDocs: Array<{ workspaceId: unknown; userId: unknown }>,
): Promise<void> {
  if (!pruneEnabled) return;
  const keep = new Set(
    memberDocs.map(
      m => `${toPgId(String(m.workspaceId))}|${toPgId(String(m.userId))}`,
    ),
  );
  const db = getDb();
  const existing = await db
    .select({
      id: workspaceMembers.id,
      workspaceId: workspaceMembers.workspaceId,
      userId: workspaceMembers.userId,
    })
    .from(workspaceMembers);
  const stale = existing
    .filter(r => !keep.has(`${r.workspaceId}|${r.userId}`))
    .map(r => r.id);
  for (let i = 0; i < stale.length; i += 500) {
    await db
      .delete(workspaceMembers)
      .where(inArray(workspaceMembers.id, stale.slice(i, i + 500)));
  }
  if (stale.length > 0) {
    log.info("backfill prune workspace_members", { deleted: stale.length });
  }
}

async function backfillConnections(): Promise<void> {
  const cc = newCounts();
  // `.lean()` preserves the encrypted credential blob as stored in Mongo;
  // it decrypts later via the repository with the same ENCRYPTION_KEY.
  const connectionDocs = await DatabaseConnection.find().lean();
  for (const c of connectionDocs) {
    await upsertRow(
      databaseConnections,
      {
        id: toPgId(String(c._id)),
        workspaceId: toPgId(String(c.workspaceId)),
        name: c.name,
        type: c.type,
        connection: c.connection ?? {},
        isDemo: c.isDemo ?? false,
        createdBy: toPgId(String(c.createdBy)),
        lastConnectedAt: asDate(c.lastConnectedAt),
        createdAt: asDate(c.createdAt),
        updatedAt: asDate(c.updatedAt),
      },
      cc,
      "database_connection",
    );
  }
  log.info("backfill database_connections", cc);

  const connSet = await loadIdSet(databaseConnections);
  const kc = newCounts();
  const connectorDocs = await Connector.find().lean();
  for (const c of connectorDocs) {
    await upsertRow(
      connectors,
      {
        id: toPgId(String(c._id)),
        workspaceId: toPgId(String(c.workspaceId)),
        name: c.name,
        type: c.type,
        description: c.description ?? null,
        config: c.config ?? null,
        settings: c.settings ?? null,
        // Drop dangling refs (deleted connections) instead of failing the row.
        targetDatabases: (c.targetDatabases ?? [])
          .map((d: unknown) => refOrNull(d, connSet))
          .filter((d: string | null): d is string => d !== null),
        isActive: c.isActive ?? true,
        createdBy: toPgId(String(c.createdBy)),
        lastSyncedAt: asDate(c.lastSyncedAt),
        createdAt: asDate(c.createdAt),
        updatedAt: asDate(c.updatedAt),
      },
      kc,
      "connector",
    );
  }
  log.info("backfill connectors", kc);

  await pruneTable(
    connectors,
    connectorDocs.map(c => c._id),
    "connectors",
  );
  await pruneTable(
    databaseConnections,
    connectionDocs.map(c => c._id),
    "database_connections",
  );
}

async function backfillConsoles(): Promise<void> {
  const fc = newCounts();
  const folderDocs = await ConsoleFolder.find().lean();
  for (const fDoc of folderDocs) {
    const f = fDoc as Record<string, any>;
    await upsertRow(
      consoleFolders,
      {
        id: toPgId(String(f._id)),
        workspaceId: toPgId(String(f.workspaceId)),
        name: f.name,
        parentId: toPgIdOrNull(f.parentId ? String(f.parentId) : null),
        access: f.access ?? null,
        ownerId: toPgIdOrNull(f.ownerId),
        isPrivate: f.isPrivate ?? null,
        createdAt: asDate(f.createdAt),
        updatedAt: asDate(f.updatedAt),
      },
      fc,
      "console_folder",
    );
  }
  log.info("backfill console_folders", fc);

  const connSet = await loadIdSet(databaseConnections);
  const folderSet = await loadIdSet(consoleFolders);
  const cc = newCounts();
  const consoleDocs = await SavedConsole.find()
    .select("-descriptionEmbedding")
    .lean();
  for (const s of consoleDocs) {
    const sc = s as Record<string, any>;
    await upsertRow(
      savedConsoles,
      {
        id: toPgId(String(sc._id)),
        workspaceId: toPgId(String(sc.workspaceId)),
        folderId: refOrNull(sc.folderId, folderSet),
        connectionId: refOrNull(sc.connectionId, connSet),
        databaseName: sc.databaseName ?? null,
        databaseId: sc.databaseId ?? null,
        name: sc.name,
        description: sc.description ?? null,
        language: sc.language ?? null,
        code: sc.code ?? null,
        chartSpec: sc.chartSpec ?? null,
        mongoOptions: sc.mongoOptions ?? null,
        lastRun: sc.lastRun ?? null,
        access: sc.access ?? null,
        workspaceRole: sc.workspaceRole ?? null,
        sharedWith: sc.sharedWith ?? null,
        schedule: sc.schedule ?? null,
        scheduledRun: sc.scheduledRun ?? null,
        version: num(sc.version) ?? 1,
        draftRevision: num(sc.draftRevision),
        isSaved: sc.isSaved ?? true,
        isDeleted: sc.is_deleted ?? false,
        deletedAt: asDate(sc.deletedAt),
        executionCount: num(sc.executionCount) ?? 0,
        lastExecutedAt: asDate(sc.lastExecutedAt),
        createdBy: toPgIdOrNull(sc.createdBy),
        ownerId: toPgIdOrNull(sc.owner_id ?? sc.ownerId),
        createdAt: asDate(sc.createdAt),
        updatedAt: asDate(sc.updatedAt),
      },
      cc,
      "saved_console",
    );
  }
  log.info("backfill saved_consoles", cc);

  await pruneTable(
    savedConsoles,
    consoleDocs.map(s => s._id),
    "saved_consoles",
  );
  await pruneTable(
    consoleFolders,
    folderDocs.map(f => f._id),
    "console_folders",
  );
}

async function backfillChats(): Promise<void> {
  const cc = newCounts();
  const chatDocs = await Chat.find().lean();
  for (const c of chatDocs) {
    const ch = c as Record<string, any>;
    await upsertRow(
      chats,
      {
        id: toPgId(String(ch._id)),
        workspaceId: toPgId(String(ch.workspaceId)),
        title: ch.title ?? "Chat",
        threadId: ch.threadId ?? null,
        messages: ch.messages ?? [],
        activeAgent: ch.activeAgent ?? null,
        pinnedConsoleId: toPgIdOrNull(ch.pinnedConsoleId),
        activeStreamId: ch.activeStreamId ?? null,
        systemPrompt: ch.systemPrompt ?? null,
        workspacePrompt: ch.workspacePrompt ?? null,
        usage: ch.usage ?? null,
        titleGenerated: ch.titleGenerated ?? false,
        createdBy: toPgId(String(ch.createdBy)),
        createdAt: asDate(ch.createdAt),
        updatedAt: asDate(ch.updatedAt),
      },
      cc,
      "chat",
    );
  }
  log.info("backfill chats", cc);

  const ac = newCounts();
  const attachmentDocs = await ChatAttachment.find().lean();
  for (const a of attachmentDocs) {
    const at = a as Record<string, any>;
    await upsertRow(
      chatAttachments,
      {
        id: toPgId(String(at._id)),
        workspaceId: toPgId(String(at.workspaceId)),
        chatId: toPgIdOrNull(at.chatId),
        createdBy: toPgId(String(at.createdBy)),
        storageKey: at.storageKey,
        mediaType: at.mediaType ?? null,
        filename: at.filename ?? null,
        size: num(at.size),
        sha256: at.sha256 ?? null,
        createdAt: asDate(at.createdAt),
      },
      ac,
      "chat_attachment",
    );
  }
  log.info("backfill chat_attachments", ac);

  const lc = newCounts();
  const usageDocs = await LlmUsage.find().lean();
  for (const u of usageDocs) {
    const us = u as Record<string, any>;
    await upsertRow(
      llmUsage,
      {
        id: toPgId(String(us._id)),
        workspaceId: toPgId(String(us.workspaceId)),
        userId: toPgId(String(us.userId)),
        chatId: toPgIdOrNull(us.chatId ? String(us.chatId) : null),
        invocationType: us.invocationType,
        modelId: us.modelId ?? null,
        inputTokens: num(us.inputTokens),
        outputTokens: num(us.outputTokens),
        cacheReadTokens: num(us.cacheReadTokens),
        cacheWriteTokens: num(us.cacheWriteTokens),
        reasoningTokens: num(us.reasoningTokens),
        totalTokens: num(us.totalTokens),
        costUsd: num(us.costUsd) ?? null,
        steps: us.steps ?? null,
        agentId: us.agentId ?? null,
        tags: us.tags ?? null,
        durationMs: num(us.durationMs),
        createdAt: asDate(us.createdAt),
      },
      lc,
      "llm_usage",
    );
  }
  log.info("backfill llm_usage", lc);

  await pruneTable(
    llmUsage,
    usageDocs.map(u => u._id),
    "llm_usage",
  );
  await pruneTable(
    chatAttachments,
    attachmentDocs.map(a => a._id),
    "chat_attachments",
  );
  await pruneTable(
    chats,
    chatDocs.map(c => c._id),
    "chats",
  );
}

async function backfillQueries(): Promise<void> {
  const connSet = await loadIdSet(databaseConnections);
  const consoleSet = await loadIdSet(savedConsoles);
  const qc = newCounts();
  const executionDocs = await QueryExecution.find().lean();
  for (const q of executionDocs) {
    const qe = q as Record<string, any>;
    await upsertRow(
      queryExecutions,
      {
        id: toPgId(String(qe._id)),
        executedAt: asDate(qe.executedAt) ?? asDate(qe.createdAt) ?? new Date(),
        userId: toPgIdOrNull(qe.userId),
        apiKeyId: toPgIdOrNull(qe.apiKeyId ? String(qe.apiKeyId) : null),
        workspaceId: toPgId(String(qe.workspaceId)),
        connectionId: refOrNull(qe.connectionId, connSet),
        databaseName: qe.databaseName ?? null,
        consoleId: refOrNull(qe.consoleId, consoleSet),
        source: qe.source ?? null,
        databaseType: qe.databaseType ?? null,
        queryLanguage: qe.queryLanguage ?? null,
        status: qe.status ?? null,
        rowCount: num(qe.rowCount),
        durationMs: num(qe.executionTimeMs),
        bytesScanned: num(qe.bytesScanned),
        errorType: qe.errorType ?? null,
        metadata: qe.metadata ?? null,
        createdAt: asDate(qe.executedAt),
      },
      qc,
      "query_execution",
    );
  }
  log.info("backfill query_executions", qc);

  await pruneTable(
    queryExecutions,
    executionDocs.map(q => q._id),
    "query_executions",
  );
}

const DOMAINS: Record<string, () => Promise<void>> = {
  auth: backfillAuth,
  workspaces: backfillWorkspaces,
  connections: backfillConnections,
  consoles: backfillConsoles,
  chats: backfillChats,
  queries: backfillQueries,
};

// Dependency order matters for foreign keys.
const DEFAULT_ORDER = [
  "auth",
  "workspaces",
  "connections",
  "consoles",
  "chats",
  "queries",
];

export async function runBackfill(
  domains: string[],
  options: { prune?: boolean } = {},
): Promise<void> {
  const mongoUrl =
    process.env.BACKFILL_MONGO_URL ||
    process.env.DEV_DATABASE_URL ||
    process.env.DATABASE_URL;
  if (!mongoUrl) {
    throw new Error(
      "Set BACKFILL_MONGO_URL (or DEV_DATABASE_URL / DATABASE_URL) to the source Mongo URI",
    );
  }
  pruneEnabled = options.prune ?? false;

  await runMigrations();
  await mongoose.connect(mongoUrl);
  log.info("backfill: connected to source Mongo", { prune: pruneEnabled });

  try {
    for (const domain of domains) {
      const fn = DOMAINS[domain];
      if (!fn) {
        log.warn(`backfill: unknown domain '${domain}', skipping`);
        continue;
      }
      log.info(`backfill: starting domain '${domain}'`);
      await fn();
    }
  } finally {
    await mongoose.disconnect();
  }
}

function parseDomains(): string[] {
  const arg = process.argv.find(a => a.startsWith("--domains="));
  if (!arg) return DEFAULT_ORDER;
  const requested = arg
    .slice("--domains=".length)
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);
  // Preserve dependency order regardless of request order.
  return DEFAULT_ORDER.filter(d => requested.includes(d));
}

if (require.main === module) {
  runBackfill(parseDomains(), { prune: process.argv.includes("--prune") })
    .then(async () => {
      console.log("backfill: OK");
      await closePostgres();
      process.exit(0);
    })
    .catch(async err => {
      console.error("backfill: FAILED", err);
      await closePostgres();
      process.exit(1);
    });
}
