import type { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate as drizzlePgliteMigrate } from "drizzle-orm/pglite/migrator";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
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
import { extractModifiedConsoleIds } from "../../routes/chats";
import {
  decodeChatListCursor,
  PgChatRepository,
  type StoredChatMessage,
} from "./index";

describe("Postgres chat repository and schema", () => {
  let pg: PGlite;
  let db: MakoPgDb;
  let pgRepo: PgChatRepository;

  const user1Uuid = generateUuidv7();
  const user2Uuid = generateUuidv7();
  const wsId = newDualId().oid;
  const wsUuid = objectIdToUuid(wsId);

  beforeAll(async () => {
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

    pgRepo = new PgChatRepository({ getDb: () => db });
  });

  afterAll(async () => {
    resetPgTestDb();
    await pg.close();
  });

  beforeEach(async () => {
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

  it("paginates user chats by descending timestamp and ID and lists app chats separately", async () => {
    const base = Date.UTC(2026, 6, 1, 12, 0, 0);
    const chatId = (index: number) => index.toString(16).padStart(24, "0");
    // 11 chats across 3 tied updatedAt buckets + 1 workflow + 1 app chat (both excluded from user list)
    for (let i = 0; i < 11; i++) {
      await pgRepo.create({
        id: chatId(i),
        workspaceId: wsId,
        createdBy: user1Uuid,
        title: `Chat ${i}`,
        createdAt: new Date(base),
        updatedAt: new Date(base + (i % 3) * 60_000),
      });
    }
    const wfId = newDualId(base + 50_000).oid;
    const appChatId = newDualId(base + 51_000).oid;
    const appId = newDualId().oid;
    await pgRepo.create({
      id: wfId,
      workspaceId: wsId,
      createdBy: user1Uuid,
      title: "Workflow run",
      source: "workflow",
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

    const pages = [
      [8, 5, 2],
      [10, 7, 4],
      [1, 9, 6],
      [3, 0],
    ];
    let cursor: string | null = null;
    for (const expected of pages) {
      const page = await pgRepo.listUserChats({
        workspaceId: wsId,
        userId: user1Uuid,
        limit: 3,
        after: cursor ? decodeChatListCursor(cursor) : null,
      });
      expect(page.chats.map(chat => chat._id)).toEqual(expected.map(chatId));
      const last = expected[expected.length - 1];
      const expectedCursor =
        expected.length === 3
          ? Buffer.from(
              JSON.stringify({
                u: base + (last % 3) * 60_000,
                i: chatId(last),
              }),
            ).toString("base64url")
          : null;
      expect(page.nextCursor).toBe(expectedCursor);
      cursor = page.nextCursor;
    }

    const appChats = await pgRepo.listAppChats(wsId, appId, user1Uuid);
    expect(appChats.map(chat => chat.id)).toEqual([appChatId]);
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

  it("preserves JSON-encoded string tool payloads without Drizzle double-parsing (findById, findByIds, prefix preservation)", async () => {
    const chat = await pgRepo.create({
      workspaceId: wsId,
      createdBy: user1Uuid,
      title: "JSON string tool outputs",
    });

    const jsonStringOutput = JSON.stringify({
      results: "# Search Results\nFound 2 messages",
      pagination_info: { page: 1 },
    });
    const initialMessages: StoredChatMessage[] = [
      {
        id: "m-json-str-1",
        role: "assistant",
        parts: [
          {
            type: "tool-mcp_slack_search",
            toolCallId: "tc-json-str-1",
            toolName: "mcp_slack_search",
            state: "output-available",
            input: '{"query":"hello"}',
            output: jsonStringOutput,
            rawInput: '{"query":"hello"}',
            toolMetadata: "123",
          },
          {
            type: "tool-mcp_scalar_strings",
            toolCallId: "tc-json-str-2",
            toolName: "mcp_scalar_strings",
            state: "output-available",
            input: "null",
            output: "true",
            toolMetadata: "false",
          },
        ],
      },
    ];

    await pgRepo.saveMessages({
      chatId: chat.id,
      workspaceId: wsId,
      userId: user1Uuid,
      messages: initialMessages,
    });

    // 1. findById preserves exact string types (never double-parsed into objects/numbers/booleans/null)
    const loadedSingle = await pgRepo.findById(chat.id, wsId);
    if (!loadedSingle) throw new Error("expected loadedSingle chat");
    const p0 = loadedSingle.messages[0].parts[0];
    const p1 = loadedSingle.messages[0].parts[1];
    expect(typeof p0.input).toBe("string");
    expect(p0.input).toBe('{"query":"hello"}');
    expect(typeof p0.output).toBe("string");
    expect(p0.output).toBe(jsonStringOutput);
    expect(typeof p0.rawInput).toBe("string");
    expect(p0.rawInput).toBe('{"query":"hello"}');
    expect(typeof p0.toolMetadata).toBe("string");
    expect(p0.toolMetadata).toBe("123");

    expect(typeof p1.input).toBe("string");
    expect(p1.input).toBe("null");
    expect(typeof p1.output).toBe("string");
    expect(p1.output).toBe("true");
    expect(typeof p1.toolMetadata).toBe("string");
    expect(p1.toolMetadata).toBe("false");

    // 2. findByIds batch hydration returns identical exact string types
    const batchMap = await pgRepo.findByIds([chat.id]);
    const loadedBatch = batchMap.get(objectIdToUuid(chat.id));
    expect(loadedBatch?.messages[0].parts[0].output).toBe(jsonStringOutput);
    expect(loadedBatch?.messages[0].parts[1].input).toBe("null");
    expect(loadedBatch?.messages[0].parts[1].output).toBe("true");

    // 3. Diff-aware prefix preservation keeps original chat_message_parts.id intact on append
    const beforeRows = await pg.query<{ id: string }>(
      `SELECT id FROM chat_message_parts WHERE chat_id = $1 ORDER BY order_index`,
      [objectIdToUuid(chat.id)],
    );
    const beforeIds = beforeRows.rows.map(r => r.id);
    expect(beforeIds).toHaveLength(2);
    await pgRepo.saveMessages({
      chatId: chat.id,
      workspaceId: wsId,
      userId: user1Uuid,
      messages: [
        ...initialMessages,
        {
          id: "m-json-str-2",
          role: "user",
          parts: [{ type: "text", text: "Follow-up" }],
        },
      ],
    });
    const afterRows = await pg.query<{ id: string }>(
      `SELECT p.id FROM chat_message_parts p
         JOIN chat_messages m ON m.id = p.message_id
        WHERE p.chat_id = $1
        ORDER BY m.ordinal, p.order_index`,
      [objectIdToUuid(chat.id)],
    );
    const afterIds = afterRows.rows.map(r => r.id);
    expect(afterIds.slice(0, beforeIds.length)).toEqual(beforeIds);
  });
});
