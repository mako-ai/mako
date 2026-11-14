/**
 * GET /api/workspaces/:wid/chats against an in-memory Mongo, as workspace
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
 * - the sort is served by the list index (no in-memory SORT stage).
 *
 * Run with: pnpm --filter api exec tsx src/routes/chats-list.db.test.ts
 */
import assert from "node:assert/strict";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Types } from "mongoose";
import { OpenAPIHono } from "@hono/zod-openapi";

import { hashApiKey } from "../auth/api-key.middleware";
import { User } from "../database/schema";
import { Chat, Workspace, WorkspaceMember } from "../database/workspace-schema";
import { loggingMiddleware } from "../logging";
import {
  CHAT_LIST_SORT,
  buildChatListFilter,
  encodeChatListCursor,
} from "../services/chat-list.service";
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

async function seedWorkspace(): Promise<Types.ObjectId> {
  const ws = new Types.ObjectId();
  await Workspace.collection.insertOne({
    _id: ws,
    name: "t",
    slug: `t-${ws}`,
    createdBy: "ana",
    settings: {},
    apiKeys: PEOPLE.map(p => ({
      _id: new Types.ObjectId(),
      name: p,
      keyHash: hashApiKey(`${keyOf(p)}_${ws}`),
      prefix: `${keyOf(p)}_${ws}`.slice(0, 14),
      createdAt: new Date(),
      createdBy: p,
    })),
  });
  for (const p of PEOPLE) {
    await WorkspaceMember.create({
      workspaceId: ws,
      userId: p,
      role: "member",
      joinedAt: new Date(),
    });
  }
  return ws;
}

async function main() {
  process.env.ENCRYPTION_KEY ??= "0".repeat(64);
  const mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri(), { dbName: "mako" });
  try {
    for (const p of PEOPLE) {
      await User.create({ _id: p, email: `${p}@example.com` });
    }
    const ws = await seedWorkspace();
    const otherWs = await seedWorkspace();

    const list = async (
      p: Person,
      query = "",
      workspace: Types.ObjectId = ws,
    ): Promise<{ status: number; body: ListBody }> => {
      const response = await app.request(
        `/api/workspaces/${workspace}/chats${query}`,
        { headers: { Authorization: `Bearer ${keyOf(p)}_${workspace}` } },
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
      _id: new Types.ObjectId(),
      workspaceId: ws,
      title: `chat ${i}`,
      createdBy: "ana",
      titleGenerated: true,
      messages: [{ id: `m${i}`, role: "user", content: "x".repeat(200) }],
      turnCheckpoint: {
        message: { big: true },
        at: new Date(),
        streamId: "s",
      },
      systemPrompt: "secret system prompt",
      workspacePrompt: "workspace prompt",
      usage: {
        promptTokens: 1,
        completionTokens: 2,
        totalTokens: 3,
        costUsd: 0.5,
        history: [{ at: new Date(), totalTokens: 3 }],
      },
      activeStreamId: i === 0 ? "stream-0" : null,
      createdAt: new Date(base),
      updatedAt: new Date(base + Math.floor(i / 5) * 60_000),
    }));
    await Chat.collection.insertMany(anaChats);
    // Not listed for ana: bo's chat, ana's chat in another workspace, an app
    // chat and a workflow-step run.
    const hidden = [
      { workspaceId: ws, createdBy: "bo", title: "bo's" },
      { workspaceId: otherWs, createdBy: "ana", title: "other ws" },
      { workspaceId: ws, createdBy: "ana", title: "app", appId: "sales" },
      { workspaceId: ws, createdBy: "ana", title: "wf", source: "workflow" },
    ];
    await Chat.collection.insertMany(
      hidden.map(h => ({
        ...h,
        messages: [],
        titleGenerated: false,
        createdAt: new Date(base),
        updatedAt: new Date(base + 10 * 86_400_000),
      })),
    );

    const expectedOrder = [...anaChats]
      .sort(
        (a, b) =>
          b.updatedAt.getTime() - a.updatedAt.getTime() ||
          b._id.toString().localeCompare(a._id.toString()),
      )
      .map(c => c._id.toString());

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
      c => c._id === anaChats[0]._id.toString(),
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
    const cross = await app.request(`/api/workspaces/${otherWs}/chats`, {
      headers: { Authorization: `Bearer ${keyOf("ana")}_${ws}` },
    });
    assert.equal(cross.status, 403);

    // Legacy chats without updatedAt sort last and are still reachable.
    const undated = [new Types.ObjectId(), new Types.ObjectId()];
    await Chat.collection.insertMany(
      undated.map((_id, i) => ({
        _id,
        workspaceId: ws,
        createdBy: "ana",
        title: `undated ${i}`,
        messages: [],
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

    // The list index serves the sort, with or without a cursor.
    await Chat.createIndexes();
    for (const after of [
      null,
      { updatedAt: base, id: anaChats[3]._id.toString() },
    ]) {
      const explained = (await Chat.find(
        buildChatListFilter({ workspaceId: String(ws), userId: "ana", after }),
      )
        .sort(CHAT_LIST_SORT)
        .limit(31)
        .explain("queryPlanner")) as unknown as {
        queryPlanner: { winningPlan: unknown };
      };
      const plan = JSON.stringify(explained.queryPlanner.winningPlan);
      assert.ok(
        !plan.includes('"stage":"SORT"'),
        `sort is index-served (cursor: ${Boolean(after)}): ${plan}`,
      );
      assert.ok(
        plan.includes("workspaceId_1_createdBy_1_updatedAt_-1__id_-1"),
        plan,
      );
    }
    assert.ok(encodeChatListCursor({ updatedAt: null, id: "a".repeat(24) }));

    console.info("chats-list.db.test: all assertions passed");
  } finally {
    await mongoose.disconnect();
    await mongo.stop();
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
