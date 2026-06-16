/* eslint-disable no-console, no-process-exit */
/**
 * One-time / repeatable ETL that copies Mako's metadata from MongoDB into the
 * Postgres (Drizzle) store, using the deterministic ObjectId -> uuid mapping so
 * cross-document references resolve without a lookup table.
 *
 * Idempotent: every insert is `onConflictDoNothing` on the primary key, so the
 * backfill can run repeatedly (the dual-write phase keeps the tail in sync).
 *
 * Usage:
 *   BACKFILL_MONGO_URL=<mongo uri> POSTGRES_URL=<pg uri> \
 *     tsx src/db/backfill.ts [--domains=auth,workspaces,connections,consoles,chats,queries]
 *
 * Connection/connector credential blobs are copied as-is (still ciphertext from
 * Mongo); they decrypt with the same ENCRYPTION_KEY via the repositories.
 */
import mongoose from "mongoose";

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

type Counts = { inserted: number; skipped: number; failed: number };

function newCounts(): Counts {
  return { inserted: 0, skipped: 0, failed: 0 };
}

/** Insert one row, swallowing per-row errors so one bad doc never aborts the run. */
async function insertRow(
  table: any,
  values: Record<string, unknown>,
  counts: Counts,
  label: string,
): Promise<void> {
  try {
    const result = await getDb()
      .insert(table)
      .values(values)
      .onConflictDoNothing()
      .returning({ id: table.id });
    if (result.length > 0) {
      counts.inserted++;
    } else {
      counts.skipped++;
    }
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
  for (const u of await User.find().lean()) {
    await insertRow(
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
  for (const s of await Session.find().lean()) {
    await insertRow(
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
  for (const o of await OAuthAccount.find().lean()) {
    await insertRow(
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
  for (const e of await EmailVerification.find().lean()) {
    await insertRow(
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
}

async function backfillWorkspaces(): Promise<void> {
  const wc = newCounts();
  const akc = newCounts();
  for (const w of await Workspace.find().lean()) {
    await insertRow(
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
      await insertRow(
        // workspace_api_keys imported lazily below to keep deps flat
        (await import("./schema")).workspaceApiKeys,
        {
          id: k._id ? toPgId(String(k._id)) : undefined,
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
  for (const m of await WorkspaceMember.find().lean()) {
    await insertRow(
      workspaceMembers,
      {
        workspaceId: toPgId(String(m.workspaceId)),
        userId: toPgId(String(m.userId)),
        role: m.role,
        isDefaultMembership: m.isDefaultMembership ?? null,
        joinedAt: asDate(m.joinedAt),
      },
      mc,
      "workspace_member",
    );
  }
  log.info("backfill workspace_members", mc);

  const ic = newCounts();
  for (const invDoc of await WorkspaceInvite.find().lean()) {
    const inv = invDoc as Record<string, any>;
    await insertRow(
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
}

async function backfillConnections(): Promise<void> {
  const cc = newCounts();
  // `.lean()` preserves the encrypted credential blob as stored in Mongo;
  // it decrypts later via the repository with the same ENCRYPTION_KEY.
  for (const c of await DatabaseConnection.find().lean()) {
    await insertRow(
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

  const kc = newCounts();
  for (const c of await Connector.find().lean()) {
    await insertRow(
      connectors,
      {
        id: toPgId(String(c._id)),
        workspaceId: toPgId(String(c.workspaceId)),
        name: c.name,
        type: c.type,
        description: c.description ?? null,
        config: c.config ?? null,
        settings: c.settings ?? null,
        targetDatabases: (c.targetDatabases ?? []).map((d: unknown) =>
          toPgId(String(d)),
        ),
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
}

async function backfillConsoles(): Promise<void> {
  const fc = newCounts();
  for (const fDoc of await ConsoleFolder.find().lean()) {
    const f = fDoc as Record<string, any>;
    await insertRow(
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
  for (const s of await SavedConsole.find()
    .select("-descriptionEmbedding")
    .lean()) {
    const sc = s as Record<string, any>;
    await insertRow(
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
}

async function backfillChats(): Promise<void> {
  const cc = newCounts();
  for (const c of await Chat.find().lean()) {
    const ch = c as Record<string, any>;
    await insertRow(
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
  for (const a of await ChatAttachment.find().lean()) {
    const at = a as Record<string, any>;
    await insertRow(
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
  for (const u of await LlmUsage.find().lean()) {
    const us = u as Record<string, any>;
    await insertRow(
      llmUsage,
      {
        id: toPgId(String(us._id)),
        workspaceId: toPgId(String(us.workspaceId)),
        userId: toPgId(String(us.userId)),
        chatId: toPgIdOrNull(us.chatId ? String(us.chatId) : null),
        invocationType: us.invocationType,
        inputTokens: num(us.inputTokens),
        outputTokens: num(us.outputTokens),
        cacheTokens: num(us.cacheTokens),
        reasoningTokens: num(us.reasoningTokens),
        totalTokens: num(us.totalTokens),
        costUsd: us.costUsd != null ? String(us.costUsd) : null,
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
}

async function backfillQueries(): Promise<void> {
  const connSet = await loadIdSet(databaseConnections);
  const consoleSet = await loadIdSet(savedConsoles);
  const qc = newCounts();
  for (const q of await QueryExecution.find().lean()) {
    const qe = q as Record<string, any>;
    await insertRow(
      queryExecutions,
      {
        id: toPgId(String(qe._id)),
        userId: toPgIdOrNull(qe.userId),
        apiKeyId: toPgIdOrNull(qe.apiKeyId ? String(qe.apiKeyId) : null),
        workspaceId: toPgId(String(qe.workspaceId)),
        connectionId: refOrNull(qe.connectionId, connSet),
        consoleId: refOrNull(qe.consoleId, consoleSet),
        source: qe.source ?? null,
        databaseType: qe.databaseType ?? null,
        queryLanguage: qe.queryLanguage ?? null,
        status: qe.status ?? null,
        rowCount: num(qe.rowCount),
        durationMs: num(qe.durationMs ?? qe.executionTimeMs),
        bytesProcessed: num(qe.bytesProcessed),
        error: qe.error ?? null,
        metadata: qe.metadata ?? null,
        createdAt: asDate(qe.createdAt),
      },
      qc,
      "query_execution",
    );
  }
  log.info("backfill query_executions", qc);
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

export async function runBackfill(domains: string[]): Promise<void> {
  const mongoUrl =
    process.env.BACKFILL_MONGO_URL ||
    process.env.DEV_DATABASE_URL ||
    process.env.DATABASE_URL;
  if (!mongoUrl) {
    throw new Error(
      "Set BACKFILL_MONGO_URL (or DEV_DATABASE_URL / DATABASE_URL) to the source Mongo URI",
    );
  }

  await runMigrations();
  await mongoose.connect(mongoUrl);
  log.info("backfill: connected to source Mongo");

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
  runBackfill(parseDomains())
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
