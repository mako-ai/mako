/**
 * Phase 3 (Part 2) normalized `chat` domain repository & migration contract test suite.
 *
 * Covers:
 *   - 0008_phase3_chat schema (6 normalized tables, NO `chat_messages.parts` column,
 *     NO `chat_stream_events` / `stream_event` table) + deferred `0008a_llm_usage_chat_fk.sql`.
 *   - Lossless unpack/repack of EVERY AI SDK v7 & Local ACP part type:
 *     `text`, `reasoning` + Anthropic `providerMetadata.anthropic.signature`,
 *     `file` + `/chat-images/:id` attachment FK link, `tool-*` & `dynamic-tool`
 *     with explicit JSON `null` (`'null'::jsonb`) vs omitted `output` (`SQL NULL`),
 *     `step-start`, `source-url`, `source-document`, and Local ACP custom `other` parts.
 *   - Diff-aware prefix preservation on `saveMessages` (unchanged prefix IDs preserved;
 *     edit/regenerate rewinds tail >= N cleanly).
 *   - Multi-segment `chat_usage_entries.entry_index` idempotency with identical
 *     `assistant_message_index`.
 *   - Tied-`updatedAt` keyset pagination parity between Mongo and PG (UUIDv8 ordering).
 *   - `extractModifiedConsoleIds()` reading normalized `parts[]` + legacy `toolCalls`.
 *   - Transactional `deleteOwned` (wrong user preserves attachments; authorized delete
 *     cascades and returns `deletedAttachmentKeys`; Stage 2 tombstone blocks resurrection).
 *   - Full 5-stage lifecycle + Stage 4 -> Stage 2 instant rollback (PG->Mongo repack).
 *   - Backfill of `chats` (incl. legacy pre-`parts` synthesis) -> `chat_attachments`
 *     with orphan `ChatAttachment` quarantine + part `attachment_id` back-linking + verifier `--repair`.
 */
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import type { UIMessage } from "ai";
import { drizzle } from "drizzle-orm/pglite";
import { migrate as drizzlePgliteMigrate } from "drizzle-orm/pglite/migrator";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Types } from "mongoose";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { Chat, ChatAttachment } from "../../database/models/chats";
import {
  resetPgTestDb,
  setPgTestDb,
  type MakoPgDb,
} from "../../database/pg/client";
import {
  generateUuidv7,
  newDualId,
  objectIdToUuid,
} from "../../database/pg/id-codec";
import { resolveMigrationsFolder } from "../../database/pg/migrate";
import {
  POST_BACKFILL_STEPS,
  readPostBackfillStatements,
  runPostBackfillStep,
} from "../../database/pg/post-backfill";
import * as schema from "../../database/pg/schema";
import { createTestPglite } from "../../database/pg/test-pglite";
import {
  clearSyncRetryHandlersForTests,
  getSyncRetryHandler,
} from "../../inngest/functions/migration/sync-retry";
import {
  clearBackfillRegistryForTests,
  runBackfill,
} from "../../migration/backfill";
import { registerChatMigrationDomain } from "../../migration/domains/chat.backfill";
import { MigrationRouter } from "../../migration/router";
import {
  ShadowCompareRunner,
  type ShadowCompareEvent,
} from "../../migration/shadow-compare";
import {
  clearVerifierRegistryForTests,
  runParityVerification,
} from "../../migration/verifier";
import { extractModifiedConsoleIds } from "../../routes/chats";
import { loadOrCreateChat } from "../../services/agent-chat/chat-record";
import { saveChat } from "../../services/agent-thread.service";
import * as artifactStoreMod from "../../services/artifact-store.service";
import {
  CHAT_DOMAIN,
  decodeChatListCursor,
  DualChatRepository,
  MongoChatRepository,
  PgChatRepository,
  resetChatRepoForTests,
  setChatRepoForTests,
  type StoredChatMessage,
} from "./index";

describe("Phase 3 normalized Chat repository & migration contract suite", () => {
  let mongoServer: MongoMemoryServer;
  let pg: PGlite;
  let db: MakoPgDb;
  let mongoRepo: MongoChatRepository;
  let pgRepo: PgChatRepository;

  const user1Uuid = generateUuidv7();
  const user2Uuid = generateUuidv7();
  const wsId = newDualId().oid;
  const wsUuid = objectIdToUuid(wsId);

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri(), { dbName: "mako_chat_test" });
    await Chat.createIndexes();
    await ChatAttachment.createIndexes();

    pg = createTestPglite();
    db = drizzle(pg, { schema }) as unknown as MakoPgDb;
    const migrationsFolder = resolveMigrationsFolder();
    await drizzlePgliteMigrate(drizzle(pg), { migrationsFolder });
    await drizzlePgliteMigrate(drizzle(pg), { migrationsFolder });
    setPgTestDb(db);

    await pg.query(
      `INSERT INTO users (id, legacy_id, email) VALUES
        ($1::uuid, $1::text, 'chat-u1@example.com'),
        ($2::uuid, $2::text, 'chat-u2@example.com')`,
      [user1Uuid, user2Uuid],
    );
    await pg.query(
      `INSERT INTO workspaces (id, name, slug, created_by) VALUES ($1, 'Chat WS', 'chat-ws', $2)`,
      [wsUuid, user1Uuid],
    );

    mongoRepo = new MongoChatRepository();
    pgRepo = new PgChatRepository({ getDb: () => db });
  });

  afterAll(async () => {
    resetPgTestDb();
    await pg.close();
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  beforeEach(async () => {
    await Promise.all([Chat.deleteMany({}), ChatAttachment.deleteMany({})]);
    await pg.exec(`
      TRUNCATE chat_message_part_metadata, chat_message_parts, chat_attachments,
               chat_usage_entries, chat_messages, chats,
               migration_domain_state, migration_backfill_jobs, migration_tombstones, migration_quarantine
      CASCADE;
    `);
  });

  it("creates exactly 6 normalized chat tables (NO chat_messages.parts, NO stream_event) and runs deferred 0008a post-backfill", async () => {
    const tables = await pg.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name IN (
            'chats', 'chat_messages', 'chat_attachments',
            'chat_message_parts', 'chat_message_part_metadata',
            'chat_usage_entries', 'chat_stream_events', 'stream_event'
          )
        ORDER BY table_name`,
    );
    expect(tables.rows.map(r => r.table_name)).toEqual([
      "chat_attachments",
      "chat_message_part_metadata",
      "chat_message_parts",
      "chat_messages",
      "chat_usage_entries",
      "chats",
    ]);

    // Confirm NO `parts` column on `chat_messages`.
    const msgCols = await pg.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'chat_messages'`,
    );
    expect(msgCols.rows.map(r => r.column_name)).not.toContain("parts");

    // Verify deferred post-backfill 0008a_llm_usage_chat_fk.sql (outside Drizzle journal).
    expect(POST_BACKFILL_STEPS.some(s => s.name === "llm-usage-chat-fk")).toBe(
      true,
    );
    expect(readPostBackfillStatements("llm-usage-chat-fk")).toHaveLength(3);

    // Execute 0008a against the real `llm_usage` table (0006) and verify dangling chat_id null-out + ON DELETE SET NULL.
    const liveChat = await pgRepo.create({
      workspaceId: wsId,
      createdBy: user1Uuid,
      title: "Linked chat",
    });
    const danglingChatUuid = newDualId().uuid;
    const usageId1 = newDualId().uuid;
    const usageId2 = newDualId().uuid;
    await pg.query(
      `INSERT INTO llm_usage (id, workspace_id, user_id, chat_id, invocation_type, model_id, input_tokens, output_tokens, total_tokens, cost_usd)
       VALUES ($1, $3, $4, $5, 'chat', 'claude-sonnet', 10, 20, 30, 0.001),
              ($2, $3, $4, $6, 'chat', 'claude-sonnet', 10, 20, 30, 0.001)`,
      [
        usageId1,
        usageId2,
        objectIdToUuid(wsId),
        user1Uuid,
        objectIdToUuid(liveChat.id),
        danglingChatUuid,
      ],
    );

    try {
      await runPostBackfillStep(db, "llm-usage-chat-fk");
      // Re-running is idempotent.
      await runPostBackfillStep(db, "llm-usage-chat-fk");

      const rowsAfterAttach = await pg.query<{ chat_id: string | null }>(
        `SELECT chat_id FROM llm_usage WHERE id IN ($1, $2) ORDER BY chat_id NULLS LAST`,
        [usageId1, usageId2],
      );
      expect(rowsAfterAttach.rows.map(r => r.chat_id)).toEqual([
        objectIdToUuid(liveChat.id),
        null,
      ]);

      // Deleting the chat sets llm_usage.chat_id = NULL via ON DELETE SET NULL.
      await pgRepo.deleteOwned(wsId, liveChat.id, user1Uuid);
      const rowsAfterDelete = await pg.query<{ chat_id: string | null }>(
        `SELECT chat_id FROM llm_usage WHERE id IN ($1, $2)`,
        [usageId1, usageId2],
      );
      expect(rowsAfterDelete.rows.every(r => r.chat_id === null)).toBe(true);
    } finally {
      await pg.query(`DELETE FROM llm_usage WHERE id IN ($1, $2)`, [
        usageId1,
        usageId2,
      ]);
      await pg.exec(
        `ALTER TABLE llm_usage DROP CONSTRAINT IF EXISTS fk_llm_usage_chat;`,
      );
    }
  });

  it("round-trips EVERY AI SDK v7 & Local ACP part type losslessly (incl. signature, explicit JSON null vs omitted output, attachment FK)", async () => {
    const chat = await pgRepo.create({
      workspaceId: wsId,
      createdBy: user1Uuid,
      title: "All Part Types",
    });
    const attachment = await pgRepo.createAttachmentIdempotent({
      workspaceId: wsId,
      chatId: chat.id,
      createdBy: user1Uuid,
      storageKey: `chat-attachments/${wsId}/${chat.id}/abc123`,
      mediaType: "image/png",
      filename: "diagram.png",
      size: 2048,
      sha256: "abc123",
    });

    const exactSignature =
      "ErUBCkYIBBgCIkB/ExactByteSignature+With/Symbols==9988776655";
    const proxyUrl = `/api/workspaces/${wsId}/chat-images/${attachment.id}`;

    const messages: StoredChatMessage[] = [
      {
        id: "m-user-1",
        role: "user",
        metadata: { clientOrigin: "web", viewport: 1440 },
        parts: [
          { type: "text", text: "" }, // Empty text allowed!
          { type: "text", text: "Analyze this screenshot" },
          {
            type: "file",
            url: proxyUrl,
            mediaType: "image/png",
            filename: "diagram.png",
          },
          {
            type: "file",
            url: "https://cdn.example.com/public.pdf",
            mediaType: "application/pdf",
          },
        ],
      },
      {
        id: "m-asst-1",
        role: "assistant",
        parts: [
          { type: "step-start" },
          {
            type: "reasoning",
            reasoning: "", // Signed empty reasoning block!
            providerMetadata: { anthropic: { signature: exactSignature } },
          },
          {
            type: "reasoning",
            reasoning: "Thinking step 1",
            providerMetadata: {
              anthropic: { signature: `${exactSignature}-2` },
            },
          },
          // Static tool with EXPLICIT JSON null output ('null'::jsonb)
          {
            type: "tool-modify_console",
            toolCallId: "tc-null-out",
            toolName: "modify_console",
            state: "output-available",
            input: { consoleId: "507f1f77bcf86cd799439011", code: "SELECT 1" },
            output: null,
            callProviderMetadata: { gateway: { step: 1 } },
            resultProviderMetadata: { gateway: { cached: true } },
            toolMetadata: { durationMs: 42 },
            title: "Update console",
          },
          // Dynamic tool with OMITTED output (SQL NULL) & approval metadata
          {
            type: "dynamic-tool",
            toolCallId: "tc-approval",
            toolName: "mcp_slack_post_message",
            state: "approval-responded",
            input: { channel: "#ops", text: "Deploy ready" },
            approval: { id: "apr-1", approved: true },
            callProviderMetadata: { provider: "gateway" },
          },
          // Tool error with rawInput
          {
            type: "tool-run_console",
            toolCallId: "tc-err",
            toolName: "run_console",
            state: "output-error",
            input: { consoleId: "507f1f77bcf86cd799439012" },
            rawInput: '{"broken":',
            errorText: "Syntax error near FROM",
            providerExecuted: false,
            preliminary: false,
          },
          // Source parts
          {
            type: "source-url",
            sourceId: "src-1",
            url: "https://docs.mako.ai",
            title: "Mako Docs",
          },
          {
            type: "source-document",
            sourceId: "doc-1",
            mediaType: "text/plain",
            title: "Schema notes",
          },
          // Local ACP custom part (`other`)
          {
            type: "data-acp-terminal",
            sessionId: "acp-sess-1",
            exitCode: 0,
            lines: ["ok"],
          },
          { type: "text", text: "All done." },
        ],
      },
    ];

    await pgRepo.saveMessages({
      chatId: chat.id,
      workspaceId: wsId,
      userId: user1Uuid,
      messages,
    });

    const loaded = await pgRepo.findById(chat.id, wsId);
    if (!loaded) throw new Error("expected loaded chat");
    expect(loaded.messages).toHaveLength(2);
    expect(loaded.messages[0].metadata).toEqual({
      clientOrigin: "web",
      viewport: 1440,
    });

    // Verify `file` part with `/chat-images/:id` linked `attachment_id` FK in PG!
    const fileRows = await pg.query<{
      file_url: string;
      attachment_id: string | null;
    }>(
      `SELECT file_url, attachment_id FROM chat_message_parts
        WHERE chat_id = $1 AND part_type = 'file'
        ORDER BY order_index`,
      [objectIdToUuid(chat.id)],
    );
    expect(fileRows.rows).toEqual([
      { file_url: proxyUrl, attachment_id: objectIdToUuid(attachment.id) },
      { file_url: "https://cdn.example.com/public.pdf", attachment_id: null },
    ]);

    const asstParts = loaded.messages[1].parts;
    expect(asstParts.map(p => p.type)).toEqual([
      "step-start",
      "reasoning",
      "reasoning",
      "tool-modify_console",
      "dynamic-tool",
      "tool-run_console",
      "source-url",
      "source-document",
      "data-acp-terminal",
      "text",
    ]);

    // Signed empty reasoning + second reasoning byte-exact!
    expect(asstParts[1]).toEqual({
      type: "reasoning",
      reasoning: "",
      providerMetadata: { anthropic: { signature: exactSignature } },
    });
    expect(asstParts[2]).toEqual({
      type: "reasoning",
      reasoning: "Thinking step 1",
      providerMetadata: { anthropic: { signature: `${exactSignature}-2` } },
    });

    // Explicit JSON null vs omitted output!
    const nullOutPart = asstParts[3];
    expect(Object.prototype.hasOwnProperty.call(nullOutPart, "output")).toBe(
      true,
    );
    expect(nullOutPart.output).toBeNull();
    expect(nullOutPart.callProviderMetadata).toEqual({ gateway: { step: 1 } });
    expect(nullOutPart.resultProviderMetadata).toEqual({
      gateway: { cached: true },
    });
    expect(nullOutPart.toolMetadata).toEqual({ durationMs: 42 });
    expect(nullOutPart.title).toBe("Update console");

    const omittedOutPart = asstParts[4];
    expect(omittedOutPart.type).toBe("dynamic-tool");
    expect(omittedOutPart.toolName).toBe("mcp_slack_post_message");
    expect(Object.prototype.hasOwnProperty.call(omittedOutPart, "output")).toBe(
      false,
    );
    expect(omittedOutPart.approval).toEqual({ id: "apr-1", approved: true });
    expect(omittedOutPart.callProviderMetadata).toEqual({
      provider: "gateway",
    });

    // Error part + rawInput
    expect(asstParts[5].rawInput).toBe('{"broken":');
    expect(asstParts[5].errorText).toBe("Syntax error near FROM");

    // Source + Local ACP custom `other` parts preserved verbatim!
    expect(asstParts[6]).toEqual({
      type: "source-url",
      sourceId: "src-1",
      url: "https://docs.mako.ai",
      title: "Mako Docs",
    });
    expect(asstParts[8]).toEqual({
      type: "data-acp-terminal",
      sessionId: "acp-sess-1",
      exitCode: 0,
      lines: ["ok"],
    });

    // Verify extractModifiedConsoleIds inspects normalized parts[] AND legacy toolCalls.
    expect(
      extractModifiedConsoleIds([
        { parts: loaded.messages[1].parts },
        {
          parts: [
            {
              type: "dynamic-tool",
              toolName: "create_console",
              output: { consoleId: "507f1f77bcf86cd799439013" },
            },
          ],
        },
        {
          toolCalls: [
            {
              toolName: "open_console",
              input: { consoleId: "507f1f77bcf86cd799439014" },
            },
          ],
        },
      ]),
    ).toEqual([
      "507f1f77bcf86cd799439011",
      "507f1f77bcf86cd799439012",
      "507f1f77bcf86cd799439013",
      "507f1f77bcf86cd799439014",
    ]);
  });

  it("preserves unchanged prefix IDs on saveMessages, rewinds tail on edit, and allocates collision-free entry_index across multi-segment turns", async () => {
    const chatId = newDualId().oid;
    const msg0: StoredChatMessage = {
      id: "u0",
      role: "user",
      parts: [{ type: "text", text: "Turn 1" }],
    };
    const msg1: StoredChatMessage = {
      id: "a0",
      role: "assistant",
      parts: [{ type: "text", text: "Segment 1 partial" }],
    };

    // Segment 1 of assistant message 0
    await pgRepo.saveMessages({
      chatId,
      workspaceId: wsId,
      userId: user1Uuid,
      messages: [msg0, msg1],
      usage: {
        assistantMessageIndex: 0,
        promptTokens: 100,
        completionTokens: 20,
        totalTokens: 120,
        costUsd: 0.001,
        model: "anthropic/claude-sonnet-4",
      },
    });
    const idsAfterSeg1 = await pgRepo.getMessageAndPartIds(chatId);
    const msg0Id = idsAfterSeg1.messages[0].id;
    const msg0Part = idsAfterSeg1.parts.find(p => p.messageId === msg0Id);
    if (!msg0Part) throw new Error("expected msg0Part");
    const msg0PartId = msg0Part.id;

    // Segment 2 appends a second turn AND records another usage entry sharing assistantMessageIndex = 0!
    const msg2: StoredChatMessage = {
      id: "u1",
      role: "user",
      parts: [{ type: "text", text: "Turn 2" }],
    };
    const afterSeg2 = await pgRepo.saveMessages({
      chatId,
      workspaceId: wsId,
      userId: user1Uuid,
      messages: [msg0, msg1, msg2],
      usage: {
        assistantMessageIndex: 0, // Same assistantMessageIndex as Segment 1!
        promptTokens: 200,
        completionTokens: 50,
        totalTokens: 250,
        cacheReadTokens: 80,
        costUsd: 0.0025,
        model: "anthropic/claude-sonnet-4",
      },
    });
    if (!afterSeg2) throw new Error("expected afterSeg2");

    const idsAfterSeg2 = await pgRepo.getMessageAndPartIds(chatId);
    // Prefix ordinal 0 & 1 IDs MUST be preserved!
    expect(idsAfterSeg2.messages[0].id).toBe(msg0Id);
    expect(idsAfterSeg2.messages[1].id).toBe(idsAfterSeg1.messages[1].id);
    expect(idsAfterSeg2.parts.find(p => p.messageId === msg0Id)?.id).toBe(
      msg0PartId,
    );

    // Multi-segment entry_index allocation & denormalized rollups!
    expect(afterSeg2.usage.totalTokens).toBe(370);
    expect(afterSeg2.usage.cacheReadTokens).toBe(80);
    expect(afterSeg2.usage.costUsd).toBeCloseTo(0.0035, 8);
    expect(afterSeg2.usage.history.map(h => h.entryIndex)).toEqual([0, 1]);
    expect(afterSeg2.usage.history.map(h => h.messageIndex)).toEqual([0, 0]);

    // Rewind/edit at ordinal 1 -> ordinal 0 stays intact, ordinals >= 1 replaced!
    const editedMsg1: StoredChatMessage = {
      id: "a0-regen",
      role: "assistant",
      parts: [{ type: "text", text: "Regenerated answer" }],
    };
    const afterEdit = await pgRepo.saveMessages({
      chatId,
      workspaceId: wsId,
      userId: user1Uuid,
      messages: [msg0, editedMsg1],
    });
    if (!afterEdit) throw new Error("expected afterEdit");
    const idsAfterEdit = await pgRepo.getMessageAndPartIds(chatId);
    expect(afterEdit.messages).toHaveLength(2);
    expect(idsAfterEdit.messages[0].id).toBe(msg0Id);
    expect(idsAfterEdit.messages[1].id).not.toBe(idsAfterSeg1.messages[1].id);
  });

  it("matches Mongo and Postgres keyset pagination byte-for-byte across tied updatedAt timestamps", async () => {
    const base = Date.UTC(2026, 6, 1, 12, 0, 0);
    // 11 chats across 3 tied updatedAt buckets + 1 workflow + 1 app chat (both excluded from user list)
    for (let i = 0; i < 11; i++) {
      const id = newDualId(base + i * 1000).oid;
      const tiedUpdatedAt = new Date(base + Math.floor(i / 4) * 60_000);
      const input = {
        id,
        workspaceId: wsId,
        createdBy: user1Uuid,
        title: `Chat ${i}`,
        createdAt: new Date(base),
        updatedAt: tiedUpdatedAt,
      };
      await mongoRepo.create(input);
      await pgRepo.create(input);
    }
    const wfId = newDualId(base + 50_000).oid;
    const appChatId = newDualId(base + 51_000).oid;
    const appId = newDualId().oid;
    await mongoRepo.create({
      id: wfId,
      workspaceId: wsId,
      createdBy: user1Uuid,
      title: "Workflow run",
      source: "workflow",
      updatedAt: new Date(base + 999_000),
    });
    await pgRepo.create({
      id: wfId,
      workspaceId: wsId,
      createdBy: user1Uuid,
      title: "Workflow run",
      source: "workflow",
      updatedAt: new Date(base + 999_000),
    });
    await mongoRepo.create({
      id: appChatId,
      workspaceId: wsId,
      createdBy: user1Uuid,
      title: "App chat",
      source: "app",
      appId,
      updatedAt: new Date(base + 999_000),
    });
    await pgRepo.create({
      id: appChatId,
      workspaceId: wsId,
      createdBy: user1Uuid,
      title: "App chat",
      source: "app",
      appId,
      updatedAt: new Date(base + 999_000),
    });

    // Walk pages of size 3 (regularly splits tied buckets) on BOTH stores and compare every page!
    let mongoCursor: string | null = null;
    let pgCursor: string | null = null;
    const mongoWalk: string[] = [];
    const pgWalk: string[] = [];

    do {
      const mPage = await mongoRepo.listUserChats({
        workspaceId: wsId,
        userId: user1Uuid,
        limit: 3,
        after: mongoCursor ? decodeChatListCursor(mongoCursor) : null,
      });
      const pPage = await pgRepo.listUserChats({
        workspaceId: wsId,
        userId: user1Uuid,
        limit: 3,
        after: pgCursor ? decodeChatListCursor(pgCursor) : null,
      });
      expect(pPage.chats.map(c => c._id)).toEqual(mPage.chats.map(c => c._id));
      expect(pPage.nextCursor).toBe(mPage.nextCursor);
      mongoWalk.push(...mPage.chats.map(c => c._id));
      pgWalk.push(...pPage.chats.map(c => c._id));
      mongoCursor = mPage.nextCursor;
      pgCursor = pPage.nextCursor;
    } while (mongoCursor || pgCursor);

    expect(pgWalk).toHaveLength(11);
    expect(new Set(pgWalk).size).toBe(11);
    expect(pgWalk).toEqual(mongoWalk);

    // App chats list parity too.
    const mApp = await mongoRepo.listAppChats(wsId, appId, user1Uuid);
    const pApp = await pgRepo.listAppChats(wsId, appId, user1Uuid);
    expect(pApp.map(c => c.id)).toEqual([appChatId]);
    expect(mApp.map(c => c.id)).toEqual([appChatId]);
  });

  it("executes deleteOwned transactionally (preserving blobs on wrong user; returning storage keys only on authorized commit)", async () => {
    const chat = await pgRepo.create({
      workspaceId: wsId,
      createdBy: user1Uuid,
      title: "Private chat",
    });
    const att = await pgRepo.createAttachmentIdempotent({
      workspaceId: wsId,
      chatId: chat.id,
      createdBy: user1Uuid,
      storageKey: `chat-attachments/${wsId}/${chat.id}/secret-hash`,
      mediaType: "image/png",
      size: 512,
      sha256: "secret-hash",
    });

    // Wrong user -> deleted: false, empty keys, attachment row untouched!
    const denied = await pgRepo.deleteOwned(wsId, chat.id, user2Uuid);
    expect(denied).toEqual({ deleted: false, deletedAttachmentKeys: [] });
    expect(await pgRepo.findAttachmentById(wsId, att.id)).not.toBeNull();
    expect(await pgRepo.findById(chat.id, wsId)).not.toBeNull();

    // Simulated Postgres tx failure -> rolls back atomically; chat & attachment stay intact,
    // and caller never receives deletedAttachmentKeys to purge from object storage.
    await pg.exec(`
      CREATE OR REPLACE FUNCTION fail_chat_delete_test() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'simulated_delete_tx_failure';
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER trg_fail_chat_delete_test
        BEFORE DELETE ON chats
        FOR EACH ROW EXECUTE FUNCTION fail_chat_delete_test();
    `);
    try {
      let caughtErr: unknown = null;
      try {
        await pgRepo.deleteOwned(wsId, chat.id, user1Uuid);
      } catch (err) {
        caughtErr = err;
      }
      expect(caughtErr).not.toBeNull();
      const causeMsg =
        caughtErr &&
        typeof caughtErr === "object" &&
        "cause" in caughtErr &&
        caughtErr.cause instanceof Error
          ? caughtErr.cause.message
          : caughtErr instanceof Error
            ? caughtErr.message
            : String(caughtErr);
      expect(causeMsg).toContain("simulated_delete_tx_failure");
      expect(await pgRepo.findById(chat.id, wsId)).not.toBeNull();
      expect(await pgRepo.findAttachmentById(wsId, att.id)).not.toBeNull();
    } finally {
      await pg.exec(`
        DROP TRIGGER IF EXISTS trg_fail_chat_delete_test ON chats;
        DROP FUNCTION IF EXISTS fail_chat_delete_test();
      `);
    }

    // Authorized owner -> deleted: true, returns storageKey, cascades all child rows!
    const ok = await pgRepo.deleteOwned(wsId, chat.id, user1Uuid);
    expect(ok).toEqual({
      deleted: true,
      deletedAttachmentKeys: [att.storageKey],
    });
    expect(await pgRepo.findById(chat.id, wsId)).toBeNull();
    expect(await pgRepo.findAttachmentById(wsId, att.id)).toBeNull();
  });

  it("never strips tool outputs on Postgres even when mongoBsonRetryMessages is provided", async () => {
    const chatId = newDualId().oid;
    const fullMessages: StoredChatMessage[] = [
      {
        id: "m-full",
        role: "assistant",
        parts: [
          {
            type: "tool-sql_execute_query",
            toolCallId: "tc-large",
            state: "output-available",
            input: { sql: "SELECT * FROM big_table" },
            output: { rows: [{ id: 1, payload: "x".repeat(4096) }] },
          },
        ],
      },
    ];
    const strippedMessages: StoredChatMessage[] = [
      {
        id: "m-full",
        role: "assistant",
        parts: [
          {
            type: "tool-sql_execute_query",
            toolCallId: "tc-large",
            state: "output-available",
            input: { sql: "SELECT * FROM big_table" },
            output: { _truncated: true },
          },
        ],
      },
    ];

    const saved = await pgRepo.saveMessages({
      chatId,
      workspaceId: wsId,
      userId: user1Uuid,
      messages: fullMessages,
      mongoBsonRetryMessages: strippedMessages,
    });
    expect(saved?.messages[0].parts[0].output).toEqual({
      rows: [{ id: 1, payload: "x".repeat(4096) }],
    });
  });

  it("passes full 5-stage lifecycle + Stage 4->2 rollback + streaming checkpoint & conditional clearActiveStreamIfMatch", async () => {
    const shadowEvents: ShadowCompareEvent[] = [];
    const shadowRunner = new ShadowCompareRunner({
      onEvent: e => shadowEvents.push(e),
    });
    const router = new MigrationRouter({
      getDb: () => db,
      hasPg: () => true,
      enablePubSub: false,
      cacheTtlMs: 0,
      shadowRunner,
      rng: () => 0,
    });
    const dualRepo = new DualChatRepository({
      mongo: mongoRepo,
      pg: pgRepo,
      router,
      getDb: () => db,
      hasPg: () => true,
    });

    // Stage 1: mongo_only
    const c1 = await dualRepo.create({
      workspaceId: wsId,
      createdBy: user1Uuid,
      title: "Stage 1",
    });
    expect(await pgRepo.findById(c1.id, wsId)).toBeNull();

    // Stage 2: dual_write_mongo_read
    await router.setDomainState({
      domain: CHAT_DOMAIN,
      workspaceId: wsId,
      mode: "dual_write_mongo_read",
    });
    const c2 = await dualRepo.create({
      workspaceId: wsId,
      createdBy: user1Uuid,
      title: "Stage 2 Chat",
    });
    expect((await pgRepo.findById(c2.id, wsId))?.title).toBe("Stage 2 Chat");

    await dualRepo.setActiveStream(wsId, c2.id, "stream-A");
    await dualRepo.saveTurnCheckpoint(wsId, c2.id, "stream-A", {
      id: "cp-1",
      role: "assistant",
      parts: [{ type: "text", text: "In-flight text" }],
    });
    // Conditional clear with wrong streamId does NOT wipe stream-A!
    await dualRepo.clearActiveStreamIfMatch(wsId, c2.id, "stream-OLD");
    expect((await pgRepo.getStreamState(c2.id, wsId))?.activeStreamId).toBe(
      "stream-A",
    );
    await dualRepo.clearActiveStreamIfMatch(wsId, c2.id, "stream-A");
    expect(
      (await pgRepo.getStreamState(c2.id, wsId))?.activeStreamId,
    ).toBeNull();

    await dualRepo.saveMessages({
      chatId: c2.id,
      workspaceId: wsId,
      userId: user1Uuid,
      messages: [
        { id: "u1", role: "user", parts: [{ type: "text", text: "Hello" }] },
        {
          id: "a1",
          role: "assistant",
          parts: [
            {
              type: "reasoning",
              reasoning: "Step",
              providerMetadata: { anthropic: { signature: "sig-stage2" } },
            },
            { type: "text", text: "Hi!" },
          ],
        },
      ],
      usage: {
        assistantMessageIndex: 0,
        promptTokens: 50,
        completionTokens: 10,
        totalTokens: 60,
        costUsd: 0.0005,
        model: "anthropic/claude-sonnet-4",
      },
    });

    // Stage 3: dual_write_shadow_compare -> 0 mismatches
    await router.setDomainState({
      domain: CHAT_DOMAIN,
      workspaceId: wsId,
      mode: "dual_write_shadow_compare",
      shadowSampleRate: 1.0,
    });
    const readS3 = await dualRepo.findOwnedById(wsId, c2.id, user1Uuid);
    await shadowRunner.flush();
    expect(readS3?.messages).toHaveLength(2);
    expect(shadowEvents.length).toBeGreaterThanOrEqual(1);
    expect(shadowEvents.every(e => e.result === "match")).toBe(true);

    // Stage 4: dual_write_pg_read -> write Local ACP + new messages in PG & reverse-sync to Mongo
    await router.setDomainState({
      domain: CHAT_DOMAIN,
      workspaceId: wsId,
      mode: "dual_write_pg_read",
      shadowSampleRate: 1.0,
    });
    await dualRepo.saveMessages({
      chatId: c2.id,
      workspaceId: wsId,
      userId: user1Uuid,
      messages: [
        { id: "u1", role: "user", parts: [{ type: "text", text: "Hello" }] },
        {
          id: "a1",
          role: "assistant",
          parts: [
            {
              type: "reasoning",
              reasoning: "Step",
              providerMetadata: { anthropic: { signature: "sig-stage2" } },
            },
            { type: "text", text: "Hi!" },
          ],
        },
        {
          id: "u2",
          role: "user",
          parts: [{ type: "text", text: "Written in Stage 4" }],
        },
      ],
      localAcp: {
        providerId: "claude-code",
        sessionId: "sess-99",
        modelId: "claude-opus-4",
      },
      usage: {
        assistantMessageIndex: 0,
        promptTokens: 80,
        completionTokens: 20,
        totalTokens: 100,
        costUsd: 0.001,
        model: "anthropic/claude-opus-4",
      },
    });

    // Instant rollback Stage 4 -> Stage 2: Mongo MUST have the full repacked Stage 4 doc!
    await router.setDomainState({
      domain: CHAT_DOMAIN,
      workspaceId: wsId,
      mode: "dual_write_mongo_read",
    });
    const afterRollback = await dualRepo.findOwnedById(wsId, c2.id, user1Uuid);
    expect(afterRollback?.messages).toHaveLength(3);
    expect(afterRollback?.messages[2].parts[0].text).toBe("Written in Stage 4");
    expect(afterRollback?.localAcp).toEqual({
      providerId: "claude-code",
      sessionId: "sess-99",
      modelId: "claude-opus-4",
    });
    expect(afterRollback?.usage.totalTokens).toBe(160);
    expect(afterRollback?.usage.history).toHaveLength(2);

    // Stage 5: pg_only
    await router.setDomainState({
      domain: CHAT_DOMAIN,
      workspaceId: wsId,
      mode: "pg_only",
    });
    const c5 = await dualRepo.create({
      workspaceId: wsId,
      createdBy: user1Uuid,
      title: "PG Only Chat",
    });
    expect((await pgRepo.findById(c5.id, wsId))?.title).toBe("PG Only Chat");
    expect(await mongoRepo.findById(c5.id, wsId)).toBeNull();
  });

  it("backfills chats (incl. legacy pre-parts synthesis) -> chat_attachments, quarantines orphan attachments, honors tombstones, and verifies/repairs parity", async () => {
    clearBackfillRegistryForTests();
    clearVerifierRegistryForTests();
    registerChatMigrationDomain();

    // 1. Legacy pre-`parts` Mongo chat (only reasoning[], toolCalls[], content)
    const legacyId = new Types.ObjectId();
    await Chat.collection.insertOne({
      _id: legacyId,
      workspaceId: new Types.ObjectId(wsId),
      createdBy: user1Uuid,
      title: "Legacy Pre-Parts Chat",
      titleGenerated: true,
      messages: [
        { role: "user", content: "Old question" },
        {
          role: "assistant",
          content: "Old answer",
          reasoning: ["Old thought"],
          toolCalls: [
            {
              toolCallId: "legacy-tc-1",
              toolName: "modify_console",
              input: { consoleId: "507f1f77bcf86cd799439099" },
              result: { ok: true },
            },
          ],
        },
      ],
      usage: {
        promptTokens: 10,
        completionTokens: 5,
        totalTokens: 15,
        costUsd: 0.0001,
        history: [
          {
            messageIndex: 0,
            promptTokens: 10,
            completionTokens: 5,
            totalTokens: 15,
            costUsd: 0.0001,
            timestamp: new Date("2025-12-01T00:00:00Z"),
          },
        ],
      },
      createdAt: new Date("2025-12-01T00:00:00Z"),
      updatedAt: new Date("2025-12-01T00:00:00Z"),
    });

    // 2. Modern chat with a `/chat-images/:id` file part + matching attachment
    const attId = new Types.ObjectId();
    const modernChat = await mongoRepo.create({
      workspaceId: wsId,
      createdBy: user1Uuid,
      title: "With Image",
      messages: [
        {
          id: "img-m1",
          role: "user",
          parts: [
            {
              type: "file",
              url: `/api/workspaces/${wsId}/chat-images/${attId.toHexString()}`,
              mediaType: "image/png",
              filename: "shot.png",
            },
          ],
        },
      ],
    });
    await ChatAttachment.create({
      _id: attId,
      workspaceId: new Types.ObjectId(wsId),
      chatId: modernChat.id,
      createdBy: user1Uuid,
      storageKey: `chat-attachments/${wsId}/${modernChat.id}/deadbeef`,
      mediaType: "image/png",
      filename: "shot.png",
      size: 1024,
      sha256: "deadbeef",
    });

    // 3. Orphan ChatAttachment whose chatId no longer exists -> MUST be quarantined!
    await ChatAttachment.create({
      workspaceId: new Types.ObjectId(wsId),
      chatId: new Types.ObjectId().toHexString(),
      createdBy: user1Uuid,
      storageKey: `chat-attachments/${wsId}/missing/orphan`,
      mediaType: "image/png",
      size: 128,
      sha256: "orphan-sha",
    });

    // 4. Tombstoned chat (deleted during Stage 2) -> MUST NOT resurrect!
    const deadChat = await mongoRepo.create({
      workspaceId: wsId,
      createdBy: user1Uuid,
      title: "Deleted During Stage 2",
    });
    await pg.query(
      `INSERT INTO migration_tombstones (table_name, entity_id, deleted_at)
       VALUES ('chats', $1, now())`,
      [objectIdToUuid(deadChat.id)],
    );

    const summary = await runBackfill({
      domain: CHAT_DOMAIN,
      workspaceId: wsId,
      batchSize: 2,
      db,
    });
    expect(summary.status).toBe("completed");
    expect(summary.rowsQuarantined).toBe(1);
    expect(summary.rowsSkippedTombstone).toBe(1);
    expect(summary.rowsUpserted).toBe(3); // 2 chats + 1 valid attachment

    // Confirm orphan attachment was quarantined in migration_quarantine!
    const quarantine = await pg.query<{
      reason: string;
      collection_name: string;
    }>(
      `SELECT reason, collection_name FROM migration_quarantine WHERE domain = 'chat'`,
    );
    expect(quarantine.rows).toEqual([
      { reason: "orphaned_chat_missing", collection_name: "chatattachments" },
    ]);

    // Confirm legacy pre-`parts` doc synthesized normalized parts cleanly!
    const pgLegacy = await pgRepo.findById(legacyId.toHexString(), wsId);
    expect(pgLegacy?.messages[1].parts.map(p => p.type)).toEqual([
      "reasoning",
      "tool-modify_console",
      "text",
    ]);
    expect(pgLegacy?.messages[1].parts[0].reasoning).toBe("Old thought");
    expect(pgLegacy?.messages[1].parts[2].text).toBe("Old answer");

    // Confirm chat_attachments backfill back-linked chat_message_parts.attachment_id!
    const linked = await pg.query<{ attachment_id: string | null }>(
      `SELECT attachment_id FROM chat_message_parts
        WHERE chat_id = $1 AND part_type = 'file'`,
      [objectIdToUuid(modernChat.id)],
    );
    expect(linked.rows[0]?.attachment_id).toBe(
      objectIdToUuid(attId.toHexString()),
    );

    // Confirm tombstoned chat stayed absent.
    expect(await pgRepo.findById(deadChat.id, wsId)).toBeNull();

    // Remove the orphan Mongo attachment before running full parity verification.
    await ChatAttachment.deleteMany({ sha256: "orphan-sha" });

    const parityOk = await runParityVerification({
      domain: CHAT_DOMAIN,
      workspaceId: wsId,
      db,
    });
    expect(parityOk.ok).toBe(true);
    expect(parityOk.checked).toBe(3);
    expect(parityOk.matched).toBe(3);
    expect(parityOk.skippedTombstone).toBe(1);

    // Introduce drift in PG and heal with `--repair`.
    await pg.query(
      `UPDATE chats SET title = 'Drifted Title', updated_at = '2020-01-01T00:00:00Z'
        WHERE id = $1`,
      [objectIdToUuid(modernChat.id)],
    );
    const driftReport = await runParityVerification({
      domain: CHAT_DOMAIN,
      workspaceId: wsId,
      repair: true,
      db,
    });
    expect(driftReport.ok).toBe(false);
    expect(driftReport.mismatched).toBe(1);
    expect(driftReport.repaired).toBe(1);

    const healedReport = await runParityVerification({
      domain: CHAT_DOMAIN,
      workspaceId: wsId,
      db,
    });
    expect(healedReport.ok).toBe(true);
  });

  it("handles Verifier #60 regressions: wrong-user no-op tombstones, distinct 15-char legacy_id Stage 3 shadow-compare + activeStreamAliveAt, sync-retry reverse-mapping, attachment FK isolation + conflict backlink, cross-workspace loadOrCreateChat 403, and UUIDv8 Mongo symmetry", async () => {
    const legacyUserId = "u_legacy_chat01";
    const legacyUserUuid = generateUuidv7();
    await pg.query(
      `INSERT INTO users (id, legacy_id, email) VALUES ($1::uuid, $2::text, 'chat-legacy@example.com')`,
      [legacyUserUuid, legacyUserId],
    );

    const shadowEvents: ShadowCompareEvent[] = [];
    const shadowRunner = new ShadowCompareRunner({
      onEvent: e => shadowEvents.push(e),
    });
    const router = new MigrationRouter({
      getDb: () => db,
      hasPg: () => true,
      enablePubSub: false,
      cacheTtlMs: 0,
      shadowRunner,
      rng: () => 0,
    });
    const dualRepo = new DualChatRepository({
      mongo: mongoRepo,
      pg: pgRepo,
      router,
      getDb: () => db,
      hasPg: () => true,
    });

    // Stage 2: create chat + attachment + activeStream under distinct 15-char legacy_id
    await router.setDomainState({
      domain: CHAT_DOMAIN,
      workspaceId: wsId,
      mode: "dual_write_mongo_read",
    });
    const chat = await dualRepo.create({
      workspaceId: wsId,
      createdBy: legacyUserId,
      title: "Legacy Owner Chat",
    });
    const att = await dualRepo.createAttachmentIdempotent({
      workspaceId: wsId,
      chatId: chat.id,
      createdBy: legacyUserId,
      storageKey: `chat-attachments/${wsId}/${chat.id}/legacy-sha`,
      mediaType: "image/png",
      size: 256,
      sha256: "legacy-sha",
    });
    const aliveAt = new Date("2026-11-26T17:00:00.000Z");
    await dualRepo.setActiveStream(wsId, chat.id, "stream-legacy-1", aliveAt);

    // Defect #7: Mongo & PG accept UUIDv8 chatId + workspaceId symmetrically (incl. listUserChats)
    const chatUuid = objectIdToUuid(chat.id);
    expect((await mongoRepo.findById(chatUuid, wsUuid))?.id).toBe(chat.id);
    expect((await pgRepo.findById(chatUuid, wsUuid))?.id).toBe(chat.id);
    const mongoUuidList = await mongoRepo.listUserChats({
      workspaceId: wsUuid,
      userId: legacyUserId,
      limit: 10,
    });
    expect(mongoUuidList.chats.map(c => c._id)).toContain(chat.id);

    // Defect #2: Unauthorized wrong-user deleteOwned in Stage 2 returns deleted:false & ZERO tombstones!
    const denied = await dualRepo.deleteOwned(wsId, chat.id, user2Uuid);
    expect(denied).toEqual({ deleted: false, deletedAttachmentKeys: [] });
    const tombstones = await pg.query<{ table_name: string }>(
      `SELECT table_name FROM migration_tombstones`,
    );
    expect(tombstones.rows).toHaveLength(0);

    // Defect #4a + #4b: Stage 3 shadow-compare with distinct 15-char legacy_id + activeStreamAliveAt
    await router.setDomainState({
      domain: CHAT_DOMAIN,
      workspaceId: wsId,
      mode: "dual_write_shadow_compare",
      shadowSampleRate: 1.0,
    });
    await dualRepo.findById(chat.id, wsId);
    await dualRepo.findOwnedById(wsId, chat.id, legacyUserId);
    await dualRepo.findOwnershipMeta(wsId, chat.id);
    await dualRepo.getStreamState(chat.id, wsId);
    await dualRepo.findAttachmentByHash(wsId, chat.id, "legacy-sha");
    await dualRepo.findAttachmentById(wsId, att.id);
    await dualRepo.findAttachmentForUser(wsId, att.id, legacyUserId);
    await shadowRunner.flush();
    expect(shadowEvents.length).toBe(7);
    expect(shadowEvents.every(e => e.result === "match")).toBe(true);

    // Defect #5a: Cross-chat attachment URL in chat B MUST NOT link chat A's attachment!
    const chatB = await pgRepo.create({
      workspaceId: wsId,
      createdBy: legacyUserUuid,
      title: "Chat B",
    });
    await pgRepo.saveMessages({
      chatId: chatB.id,
      workspaceId: wsId,
      userId: legacyUserUuid,
      messages: [
        {
          id: "cross-1",
          role: "user",
          parts: [
            {
              type: "file",
              url: `/api/workspaces/${wsId}/chat-images/${att.id}`,
              mediaType: "image/png",
            },
          ],
        },
      ],
    });
    const crossLink = await pg.query<{ attachment_id: string | null }>(
      `SELECT attachment_id FROM chat_message_parts WHERE chat_id = $1 AND part_type = 'file'`,
      [objectIdToUuid(chatB.id)],
    );
    expect(crossLink.rows[0]?.attachment_id).toBeNull();

    // Defect #5b: upsertAttachmentWithBacklink handles (workspace_id, chat_id, sha256) conflict
    // with a different id without 23503 AND handles `?v=1` query suffix!
    const dupId = newDualId().oid;
    await pgRepo.saveMessages({
      chatId: chat.id,
      workspaceId: wsId,
      userId: legacyUserUuid,
      messages: [
        {
          id: "q-1",
          role: "user",
          parts: [
            {
              type: "file",
              url: `/api/workspaces/${wsId}/chat-images/${dupId}?v=1`,
              mediaType: "image/png",
            },
          ],
        },
      ],
    });
    const insertedDup = await pgRepo.upsertAttachmentWithBacklink(
      {
        ...att,
        id: dupId, // Different id, same (workspaceId, chatId, sha256) -> triggers ON CONFLICT DO NOTHING
      },
      legacyUserUuid,
    );
    expect(insertedDup).toBe(false);
    const backlinked = await pg.query<{ attachment_id: string | null }>(
      `SELECT attachment_id FROM chat_message_parts WHERE chat_id = $1 AND part_type = 'file'`,
      [objectIdToUuid(chat.id)],
    );
    // Linked to the actual existing row `att.id` (no 23503 FK error)!
    expect(backlinked.rows[0]?.attachment_id).toBe(objectIdToUuid(att.id));

    // Also verify idempotent same-id replay (PK conflict) + `#hash` suffix backlink!
    await pgRepo.saveMessages({
      chatId: chat.id,
      workspaceId: wsId,
      userId: legacyUserUuid,
      messages: [
        {
          id: "h-1",
          role: "user",
          parts: [
            {
              type: "file",
              url: `/api/workspaces/${wsId}/chat-images/${att.id}#frag`,
              mediaType: "image/png",
            },
          ],
        },
      ],
    });
    // Simulate part inserted before attachment back-link by clearing attachment_id
    await pg.query(
      `UPDATE chat_message_parts SET attachment_id = NULL WHERE chat_id = $1`,
      [objectIdToUuid(chat.id)],
    );
    const insertedSameId = await pgRepo.upsertAttachmentWithBacklink(
      att,
      legacyUserUuid,
    );
    expect(insertedSameId).toBe(false);
    const hashBacklinked = await pg.query<{ attachment_id: string | null }>(
      `SELECT attachment_id FROM chat_message_parts WHERE chat_id = $1 AND part_type = 'file'`,
      [objectIdToUuid(chat.id)],
    );
    expect(hashBacklinked.rows[0]?.attachment_id).toBe(objectIdToUuid(att.id));

    // Defect #6: loadOrCreateChat rejects a cross-workspace chatId with 403 instead of creating duplicate PK
    const otherWsId = newDualId().oid;
    const crossWsFailure = await loadOrCreateChat({
      chatId: chat.id,
      workspaceId: otherWsId,
      actorId: legacyUserId,
      actorEmail: "chat-legacy@example.com",
      appChat: undefined,
      messages: [
        {
          id: "u-cross",
          role: "user",
          parts: [{ type: "text", text: "Hijack attempt" }],
        },
      ],
    });
    expect(crossWsFailure).not.toBeNull();
    expect(crossWsFailure?.status).toBe(403);

    // Defect #3: replayChatWriteToMongo maps PG UUIDv7 back to legacy_id for upsert, attachment & delete!
    clearSyncRetryHandlersForTests();
    registerChatMigrationDomain();
    const mongoRetry = getSyncRetryHandler("mongo", CHAT_DOMAIN);
    if (!mongoRetry) throw new Error("expected chat mongo sync-retry handler");

    await pgRepo.updateTitle(
      wsId,
      chat.id,
      legacyUserUuid,
      "Updated In PG Stage 4",
    );
    await mongoRetry({
      target: "mongo",
      domain: CHAT_DOMAIN,
      operation: "updateTitle",
      entityId: chat.id,
      workspaceId: wsId,
      payload: { entity: "chats", workspaceId: wsId, chatId: chat.id },
      failedAt: new Date().toISOString(),
      errorMessage: "simulated_mongo_timeout",
    });
    const mongoAfterReplay = await mongoRepo.findById(chat.id, wsId);
    expect(mongoAfterReplay?.title).toBe("Updated In PG Stage 4");
    expect(mongoAfterReplay?.createdBy).toBe(legacyUserId);

    // Delete replay with PG UUIDv7 deletes the legacy-owned Mongo doc cleanly!
    await pgRepo.deleteOwned(wsId, chat.id, legacyUserUuid);
    await mongoRetry({
      target: "mongo",
      domain: CHAT_DOMAIN,
      operation: "deleteOwned",
      entityId: chat.id,
      workspaceId: wsId,
      payload: {
        entity: "chats",
        action: "delete",
        workspaceId: wsId,
        chatId: chat.id,
        userId: legacyUserUuid,
      },
      failedAt: new Date().toISOString(),
      errorMessage: "simulated_mongo_timeout",
    });
    expect(await mongoRepo.findById(chat.id, wsId)).toBeNull();
  });

  it("handles mixed-mode legacy user ownership checks in loadOrCreateChat & findOwnershipMeta (PR #1558 [4717348592])", async () => {
    const legacyOwnerId = "lucia_chat_ow01";
    const legacyOwnerUuid = generateUuidv7();
    const legacyOtherId = "lucia_chat_ot02";
    const legacyOtherUuid = generateUuidv7();
    await pg.query(
      `INSERT INTO users (id, legacy_id, email) VALUES
        ($1::uuid, $2, 'chat-mix-own@example.com'),
        ($3::uuid, $4, 'chat-mix-oth@example.com')`,
      [legacyOwnerUuid, legacyOwnerId, legacyOtherUuid, legacyOtherId],
    );

    const router = new MigrationRouter({
      getDb: () => db,
      hasPg: () => true,
      enablePubSub: false,
    });
    const dualRepo = new DualChatRepository({
      mongo: mongoRepo,
      pg: pgRepo,
      router,
      getDb: () => db,
      hasPg: () => true,
      isForceMongoOnly: () => false,
    });

    await router.setDomainState({
      domain: CHAT_DOMAIN,
      workspaceId: wsId,
      mode: "pg_only",
    });

    const appId = newDualId().oid;
    const appChat = await dualRepo.create({
      workspaceId: wsId,
      createdBy: legacyOwnerId,
      source: "app",
      appId,
      title: "App Chat",
      titleGenerated: true,
    });
    // PG returns UUIDv7 while auth (still reading Mongo) gives the 15-char Lucia ID.
    expect(appChat.createdBy).toBe(legacyOwnerUuid);

    setChatRepoForTests(dualRepo);
    try {
      const appChatCtx = {
        project: { _id: new Types.ObjectId(appId) },
      } as unknown as Parameters<typeof loadOrCreateChat>[0]["appChat"];

      // Owner continuing own app chat with legacy session ID MUST NOT get 403!
      const ownerResult = await loadOrCreateChat({
        chatId: appChat.id,
        workspaceId: wsId,
        actorId: legacyOwnerId,
        actorEmail: "chat-mix-own@example.com",
        appChat: appChatCtx,
        messages: [],
      });
      expect(ownerResult).toBeNull();

      // Different user MUST still get 403!
      const otherResult = await loadOrCreateChat({
        chatId: appChat.id,
        workspaceId: wsId,
        actorId: legacyOtherId,
        actorEmail: "chat-mix-oth@example.com",
        appChat: appChatCtx,
        messages: [],
      });
      expect(otherResult).not.toBeNull();
      expect(otherResult?.status).toBe(403);

      // ACP PUT /chats/:id/messages owner check via findOwnershipMeta(ws, id, actorUserId)
      const ownerMeta = await dualRepo.findOwnershipMeta(
        wsId,
        appChat.id,
        legacyOwnerId,
      );
      expect(ownerMeta?.isOwnedByActor).toBe(true);
      expect(ownerMeta?.titleGenerated).toBe(true);

      const uuidOwnerMeta = await dualRepo.findOwnershipMeta(
        wsId,
        appChat.id,
        legacyOwnerUuid,
      );
      expect(uuidOwnerMeta?.isOwnedByActor).toBe(true);

      const otherMeta = await dualRepo.findOwnershipMeta(
        wsId,
        appChat.id,
        legacyOtherId,
      );
      expect(otherMeta?.isOwnedByActor).toBe(false);
    } finally {
      resetChatRepoForTests();
    }
  });

  it("strips NUL bytes and unpaired surrogates on PG writes, checkpoints, and backfill without 22P05 errors (PR #1558 [4717350514])", async () => {
    const chatId = newDualId().oid;
    const msgWithNul: StoredChatMessage = {
      id: "m-nul\u0000-1",
      role: "assistant",
      metadata: { "key\u0000name": "val\u0000\uD83D" },
      parts: [
        { type: "text", text: "Hello\u0000 world 🚀 \uDE00" },
        {
          type: "tool-run_sql",
          toolCallId: "tc-nul\u0000",
          toolName: "run_sql",
          state: "output-available",
          input: { sql: "SELECT '\u0000'\uD83D" },
          output: { rows: [{ "col\u0000": "bin\u0000data 🚀 \uD83D" }] },
          errorText: "warn\u0000",
        },
      ],
    };

    const saved = await pgRepo.saveMessages({
      chatId,
      workspaceId: wsId,
      userId: user1Uuid,
      messages: [msgWithNul],
    });
    expect(saved).not.toBeNull();
    expect(saved?.messages[0]?.parts[0]?.text).toBe("Hello world 🚀 \uFFFD");
    expect(saved?.messages[0]?.parts[1]?.output).toEqual({
      rows: [{ col: "bindata 🚀 \uFFFD" }],
    });
    expect(saved?.messages[0]?.metadata).toEqual({ keyname: "val\uFFFD" });

    // Prefix preservation still matches sanitized message when client resends raw NUL message.
    const beforeIds = await pgRepo.getMessageAndPartIds(chatId);
    await pgRepo.saveMessages({
      chatId,
      workspaceId: wsId,
      userId: user1Uuid,
      messages: [
        msgWithNul,
        { id: "m-2", role: "user", parts: [{ type: "text", text: "next" }] },
      ],
    });
    const afterIds = await pgRepo.getMessageAndPartIds(chatId);
    expect(afterIds.messages[0]?.id).toBe(beforeIds.messages[0]?.id);
    expect(afterIds.parts.slice(0, beforeIds.parts.length)).toEqual(
      beforeIds.parts,
    );

    // Checkpoint & title with NUL + lone surrogate succeed in PG.
    await pgRepo.setActiveStream(wsId, chatId, "stream-nul");
    await pgRepo.saveTurnCheckpoint(wsId, chatId, "stream-nul", msgWithNul);
    expect(
      await pgRepo.updateTitle(wsId, chatId, user1Uuid, "Title\u0000\uD83D 🚀"),
    ).toBe(true);
    const reloaded = await pgRepo.findById(chatId, wsId);
    expect(reloaded?.title).toBe("Title\uFFFD 🚀");
    expect(reloaded?.turnCheckpoint).not.toBeNull();

    // Historical Mongo doc containing raw NUL + unpaired surrogate backfills & verifies cleanly.
    const mongoNulChatId = newDualId().oid;
    await Chat.create({
      _id: new Types.ObjectId(mongoNulChatId),
      workspaceId: new Types.ObjectId(wsId),
      createdBy: user1Uuid,
      title: "Legacy\u0000Chat",
      titleGenerated: true,
      messages: [
        {
          id: "hist-1",
          role: "assistant",
          content: "hi\u0000",
          parts: [
            { type: "text", text: "hi\u0000 🚀 \uD83D" },
            {
              type: "tool-query",
              toolCallId: "tc-hist",
              toolName: "query",
              state: "output-available",
              input: { q: "x\u0000" },
              output: { val: "y\u0000\uDE00" },
            },
          ],
        },
      ],
    });

    clearBackfillRegistryForTests();
    clearVerifierRegistryForTests();
    registerChatMigrationDomain();
    const bf = await runBackfill({
      domain: CHAT_DOMAIN,
      workspaceId: wsId,
      db,
    });
    expect(bf.status).toBe("completed");
    const backfilled = await pgRepo.findById(mongoNulChatId, wsId);
    expect(backfilled?.title).toBe("LegacyChat");
    expect(backfilled?.messages[0]?.parts[0]?.text).toBe("hi 🚀 \uFFFD");

    // Remove the PG-only test chat before parity verification of Mongo->PG.
    await pgRepo.deleteOwned(wsId, chatId, user1Uuid);
    const verify = await runParityVerification({
      domain: CHAT_DOMAIN,
      workspaceId: wsId,
      db,
    });
    expect(verify.ok).toBe(true);
    expect(verify.mismatched).toBe(0);
  });

  it("ensures chat row exists before externalizing attachments on brand-new ACP saveChat (PR #1558 [4717352625])", async () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "mako-chat-att-"));
    const storedBlobs = new Map<string, Buffer>();
    const fakeStore = {
      type: "filesystem" as const,
      exists: async (key: string) => storedBlobs.has(key),
      put: async () => undefined,
      putBuffer: async (buf: Buffer | Uint8Array, key: string) => {
        storedBlobs.set(key, Buffer.from(buf));
      },
      getSignedUrl: async () => null,
      openReadStream: async () => null,
      getSize: async (key: string) => storedBlobs.get(key)?.byteLength ?? null,
      getLastModified: async () => null,
      delete: async (key: string) => {
        storedBlobs.delete(key);
      },
    };
    const storeSpy = vi
      .spyOn(artifactStoreMod, "getArtifactStore")
      .mockReturnValue(fakeStore);

    const secondaryFailures: Array<{ operation: string; error: unknown }> = [];
    const router = new MigrationRouter({
      getDb: () => db,
      hasPg: () => true,
      enablePubSub: false,
      onSecondaryFailure: async ctx => {
        secondaryFailures.push({
          operation: ctx.operation,
          error: ctx.error,
        });
      },
    });
    const dualRepo = new DualChatRepository({
      mongo: mongoRepo,
      pg: pgRepo,
      router,
      getDb: () => db,
      hasPg: () => true,
      isForceMongoOnly: () => false,
    });
    setChatRepoForTests(dualRepo);

    // 1x1 transparent PNG
    const pngBase64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
    const imageMessage = {
      id: "acp-u1",
      role: "user",
      parts: [
        { type: "text", text: "See screenshot" },
        {
          type: "file",
          mediaType: "image/png",
          filename: "shot.png",
          url: `data:image/png;base64,${pngBase64}`,
        },
      ],
    } as unknown as UIMessage;

    try {
      // 1. PG-primary (`pg_only`): brand-new chat ID saved directly via saveChat (ACP PUT path)
      await router.setDomainState({
        domain: CHAT_DOMAIN,
        workspaceId: wsId,
        mode: "pg_only",
      });
      const newPgChatId = newDualId().oid;
      const savedPg = await saveChat(
        newPgChatId,
        wsId,
        user1Uuid,
        [imageMessage],
        undefined,
        {
          localAcp: {
            providerId: "claude-code",
            sessionId: "sess-1",
            modelId: "claude-sonnet",
          },
        },
      );
      expect(savedPg).not.toBeNull();
      const pgFilePart = savedPg?.messages[0]?.parts.find(
        p => p.type === "file",
      );
      expect(pgFilePart?.url).toMatch(
        new RegExp(`^/api/workspaces/${wsId}/chat-images/[0-9a-f]{24}$`),
      );
      expect(pgFilePart?.url).not.toContain("data:image/png");

      const pgPartRows = await pg.query<{ attachment_id: string | null }>(
        `SELECT attachment_id FROM chat_message_parts WHERE chat_id = $1 AND part_type = 'file'`,
        [objectIdToUuid(newPgChatId)],
      );
      expect(pgPartRows.rows[0]?.attachment_id).not.toBeNull();

      // 2. Mongo-primary dual-write (`dual_write_mongo_read`): ZERO PG secondary FK 23503 failures!
      await router.setDomainState({
        domain: CHAT_DOMAIN,
        workspaceId: wsId,
        mode: "dual_write_mongo_read",
      });
      const newDualChatId = newDualId().oid;
      const savedDual = await saveChat(newDualChatId, wsId, user1Uuid, [
        imageMessage,
      ]);
      expect(savedDual).not.toBeNull();
      expect(secondaryFailures).toEqual([]);
      const pgDualAtts = await pg.query<{ id: string }>(
        `SELECT id FROM chat_attachments WHERE chat_id = $1`,
        [objectIdToUuid(newDualChatId)],
      );
      expect(pgDualAtts.rows).toHaveLength(1);

      // 3. Existing chat header (custom title / source) is preserved when ensureExists runs again.
      const existingChat = await dualRepo.create({
        workspaceId: wsId,
        createdBy: user1Uuid,
        source: "app",
        appId: newDualId().oid,
        title: "Keep My Title",
        titleGenerated: true,
      });
      await saveChat(existingChat.id, wsId, user1Uuid, [imageMessage]);
      const afterExisting = await pgRepo.findById(existingChat.id, wsId);
      expect(afterExisting?.title).toBe("Keep My Title");
      expect(afterExisting?.source).toBe("app");
      expect(afterExisting?.titleGenerated).toBe(true);
    } finally {
      storeSpy.mockRestore();
      resetChatRepoForTests();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
