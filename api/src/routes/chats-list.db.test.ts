/**
 * GET /api/workspaces/:wid/chats against PGlite, as workspace
 * members with their own API keys:
 *
 * - keyset pages on (updatedAt desc, _id desc): chats sharing an updatedAt
 *   are neither skipped nor repeated across pages;
 * - `limit` defaults to 30, is capped at 100 and rejects 0 / non-numbers;
 * - a cursor the server did not mint is a 400;
 * - entries carry only list metadata (no messages, turnCheckpoint,
 *   usage.history, prompts);
 * - the caller sees only their own chats in this workspace (not another
 *   member's, not another workspace's, not app chats or workflow runs);
 * - the list index serves the sort and seeks to the cursor on later pages.
 *
 * Run with: pnpm --filter api exec tsx src/routes/chats-list.db.test.ts
 */
import assert from "node:assert/strict";
import { drizzle } from "drizzle-orm/pglite";
import { OpenAPIHono } from "@hono/zod-openapi";

import { hashApiKey } from "../auth/api-key.middleware";
import {
  generateObjectIdHex,
  objectIdToUuid,
  toWireId,
} from "../database/pg/id-codec";
import * as schema from "../database/pg/schema";
import { loggingMiddleware } from "../logging";
import { PgChatRepository } from "../repositories/chat";
import { workspaceRepo } from "../repositories/workspaces";
import { encodeChatListCursor } from "../services/chat-list.service";
import {
  ensureTestMember,
  ensureTestUser,
  ensureTestWorkspace,
  setupPgTestDb,
  type PgTestDb,
} from "../test-support/pg-test";
import { chatsRoutes } from "./chats";

const PEOPLE = ["ana", "bo"] as const;
type Person = (typeof PEOPLE)[number];
const keyOf = (p: Person) => `revops_chat_list_${p}_tests_only_key`;

const app = new OpenAPIHono();
app.use("*", loggingMiddleware({}));
app.route("/api/workspaces/:workspaceId/chats", chatsRoutes);

interface ListBody {
  success: boolean;
  error?: string;
  chats?: Array<Record<string, unknown> & { _id: string; title: string }>;
  nextCursor?: string | null;
}

async function seedWorkspace(h: PgTestDb) {
  const ws = await ensureTestWorkspace(h.db);
  for (const p of PEOPLE) {
    await ensureTestMember(h.db, { workspaceId: ws.id, userId: p });
    await workspaceRepo.createApiKey({
      workspaceId: ws.id,
      name: p,
      keyHash: hashApiKey(`${keyOf(p)}_${ws.id}`),
      prefix: keyOf(p).slice(0, 14),
      createdBy: p,
    });
  }
  return ws;
}

async function main() {
  process.env.ENCRYPTION_KEY ??= "0".repeat(64);
  const h = await setupPgTestDb();
  try {
    const ana = await ensureTestUser(h.db, { id: "ana" });
    const boUser = await ensureTestUser(h.db, { id: "bo" });
    const ws = await seedWorkspace(h);
    const otherWs = await seedWorkspace(h);

    const list = async (
      p: Person,
      query = "",
      workspace = ws,
    ): Promise<{ status: number; body: ListBody }> => {
      const response = await app.request(
        `/api/workspaces/${workspace.id}/chats${query}`,
        { headers: { Authorization: `Bearer ${keyOf(p)}_${workspace.id}` } },
      );
      return {
        status: response.status,
        body: (await response.json()) as ListBody,
      };
    };

    // 75 of ana's chats; groups of five share one updatedAt (ties), so a
    // page boundary regularly lands inside a tie.
    const base = Date.UTC(2026, 0, 1);
    const anaChats = Array.from({ length: 75 }, (_, i) => ({
      id: objectIdToUuid(generateObjectIdHex()),
      workspaceId: ws.uuid,
      title: `chat ${i}`,
      createdBy: ana.id,
      titleGenerated: true,
      turnCheckpoint: {
        message: { big: true },
        at: new Date().toISOString(),
        streamId: "s",
      },
      systemPrompt: "secret system prompt",
      workspacePrompt: "workspace prompt",
      usagePromptTokens: 1,
      usageCompletionTokens: 2,
      usageTotalTokens: 3,
      usageCostUsd: "0.5",
      activeStreamId: i === 0 ? "stream-0" : null,
      createdAt: new Date(base),
      updatedAt: new Date(base + Math.floor(i / 5) * 60_000),
    }));
    await h.db.insert(schema.chats).values(anaChats);
    await h.db.insert(schema.chatMessages).values(
      anaChats.map((chat, i) => ({
        chatId: chat.id,
        clientMessageId: `m${i}`,
        role: "user" as const,
        ordinal: 0,
      })),
    );
    await h.db.insert(schema.chatUsageEntries).values(
      anaChats.map(chat => ({
        chatId: chat.id,
        entryIndex: 0,
        assistantMessageIndex: 0,
        totalTokens: 3,
      })),
    );
    // Other members, workspaces, app chats and workflow runs are hidden.
    const hidden = [
      { workspaceId: ws.uuid, createdBy: boUser.id, title: "bo's" },
      { workspaceId: otherWs.uuid, createdBy: ana.id, title: "other ws" },
      {
        workspaceId: ws.uuid,
        createdBy: ana.id,
        title: "app",
        source: "app" as const,
        appId: objectIdToUuid(generateObjectIdHex()),
      },
      {
        workspaceId: ws.uuid,
        createdBy: ana.id,
        title: "wf",
        source: "workflow" as const,
      },
    ];
    await h.db.insert(schema.chats).values(
      hidden.map(chat => ({
        ...chat,
        createdAt: new Date(base),
        updatedAt: new Date(base + 10 * 86_400_000),
      })),
    );

    const expectedOrder = [...anaChats]
      .sort(
        (a, b) =>
          b.updatedAt.getTime() - a.updatedAt.getTime() ||
          toWireId(b.id).localeCompare(toWireId(a.id)),
      )
      .map(c => toWireId(c.id));

    // Default page size is 30.
    const first = await list("ana");
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(first.body.success, true);
    assert.equal(first.body.chats?.length, 30);
    assert.equal(typeof first.body.nextCursor, "string");

    // Projection: only list metadata.
    const entry = first.body.chats?.[0] ?? {};
    for (const heavy of [
      "messages",
      "turnCheckpoint",
      "systemPrompt",
      "workspacePrompt",
      "workspaceId",
      "createdBy",
    ]) {
      assert.equal(heavy in entry, false, `list entry leaks ${heavy}`);
    }
    assert.deepEqual(entry.usage, { totalTokens: 3, costUsd: 0.5 });
    assert.equal(typeof entry.updatedAt, "string");
    assert.equal(typeof entry._id, "string");

    // Walk every page at a size that splits the ties: complete, ordered,
    // no duplicates.
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const query: string = `?limit=7${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
      const page = await list("ana", query);
      assert.equal(page.status, 200, JSON.stringify(page.body));
      seen.push(...(page.body.chats ?? []).map(c => c._id));
      cursor = page.body.nextCursor ?? null;
      pages++;
      assert.ok(pages < 50, "pagination terminates");
    } while (cursor);
    assert.equal(pages, Math.ceil(75 / 7));
    assert.deepEqual(seen, expectedOrder, "keyset order, ties included");
    assert.equal(new Set(seen).size, 75, "no duplicates");
    const streaming = (await list("ana", "?limit=100")).body.chats?.find(
      c => c._id === toWireId(anaChats[0].id),
    );
    assert.equal(streaming?.activeStreamId, "stream-0");

    // An exact multiple ends with a null cursor, not an empty extra page.
    const exact = await list("ana", "?limit=75");
    assert.equal(exact.body.chats?.length, 75);
    assert.equal(exact.body.nextCursor, null);

    // Limit bounds.
    assert.equal((await list("ana", "?limit=100")).body.chats?.length, 75);
    assert.equal((await list("ana", "?limit=1")).body.chats?.length, 1);
    for (const bad of ["0", "101", "-3", "abc", "2.5"]) {
      const res = await list("ana", `?limit=${bad}`);
      assert.equal(res.status, 400, `limit=${bad} is rejected`);
      assert.equal(res.body.success, false);
    }

    // Tampered / foreign cursors are 400, not a silent first page.
    const tampered = [
      "not-a-cursor",
      Buffer.from("[1,2]").toString("base64url"),
      Buffer.from(JSON.stringify({ u: "yesterday", i: "x" })).toString(
        "base64url",
      ),
      Buffer.from(JSON.stringify({ u: 1, i: "zz" })).toString("base64url"),
      Buffer.from(JSON.stringify({ u: -1, i: "a".repeat(24) })).toString(
        "base64url",
      ),
      "x".repeat(600),
    ];
    for (const bad of tampered) {
      const res = await list("ana", `?cursor=${encodeURIComponent(bad)}`);
      assert.equal(res.status, 400, `cursor ${bad.slice(0, 20)} is rejected`);
      assert.equal(res.body.success, false);
    }

    // Isolation: bo sees only bo's chat; ana's other-workspace chat is only
    // in that workspace; a cursor from ana's walk reveals nothing to bo.
    const bo = await list("bo");
    assert.equal(bo.status, 200);
    assert.deepEqual(
      bo.body.chats?.map(c => c.title),
      ["bo's"],
    );
    const boWithAnasCursor = await list(
      "bo",
      `?cursor=${encodeURIComponent(first.body.nextCursor ?? "")}`,
    );
    assert.equal(boWithAnasCursor.status, 200);
    assert.deepEqual(boWithAnasCursor.body.chats, []);
    const other = await list("ana", "", otherWs);
    assert.deepEqual(
      other.body.chats?.map(c => c.title),
      ["other ws"],
    );
    // A key for one workspace cannot list another.
    const cross = await app.request(`/api/workspaces/${otherWs.id}/chats`, {
      headers: { Authorization: `Bearer ${keyOf("ana")}_${ws.id}` },
    });
    assert.equal(cross.status, 403);

    // The PG list's epoch sentinel for a missing updatedAt sorts last.
    const undated = [generateObjectIdHex(), generateObjectIdHex()];
    await h.db.insert(schema.chats).values(
      undated.map((id, i) => ({
        id: objectIdToUuid(id),
        workspaceId: ws.uuid,
        createdBy: ana.id,
        title: `undated ${i}`,
        updatedAt: new Date(0),
      })),
    );
    const walk: string[] = [];
    cursor = null;
    do {
      const query: string = `?limit=4${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
      const page = await list("ana", query);
      walk.push(...(page.body.chats ?? []).map(c => c._id));
      cursor = page.body.nextCursor ?? null;
    } while (cursor);
    assert.equal(walk.length, 77);
    assert.deepEqual(
      walk.slice(75),
      undated
        .map(id => id.toString())
        .sort()
        .reverse(),
      "undated chats come last, by _id desc",
    );

    // Explain the actual repository SQL for each page shape. Encourage a
    // plain index scan because the small fixture fits on a few heap pages.
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    const db = drizzle(h.pg, {
      schema,
      logger: {
        logQuery: (sql, params) => queries.push({ sql, params }),
      },
    });
    const repo = new PgChatRepository({ getDb: () => db });
    await h.pg.exec("SET enable_seqscan = off; SET enable_bitmapscan = off");
    for (const after of [
      null,
      { updatedAt: base, id: toWireId(anaChats[3].id) },
    ]) {
      await repo.listUserChats({
        workspaceId: ws.id,
        userId: ana.id,
        limit: 30,
        after,
      });
      const query = queries.pop();
      assert.ok(query);
      const { rows } = await h.pg.query<{ "QUERY PLAN": string }>(
        `EXPLAIN ${query.sql}`,
        query.params,
      );
      const plan = rows.map(row => row["QUERY PLAN"]).join("\n");
      assert.doesNotMatch(plan, /\b(?:Incremental )?Sort\s+\(/);
      assert.match(plan, /idx_chats_user_list/);
      if (after) {
        assert.match(plan, /Index Cond: .*ROW\(updated_at, id\) < ROW\(/);
      }
    }
    assert.ok(encodeChatListCursor({ updatedAt: null, id: "a".repeat(24) }));

    console.info("chats-list.db.test: all assertions passed");
  } finally {
    await h.close();
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
