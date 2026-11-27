/**
 * Byte-exact prompt-cache preservation tests (`exact-history.ts`):
 *   - `jsonbKeyOrder` & `jsonbOrdered` match real Postgres (PGlite) `jsonb` key sorting
 *     including length-first, lexicographic tie-breaking, UTF-8 multi-byte keys, and nesting.
 *   - `withJsonbOrderedOutputs` stays synchronous for async-iterable streaming tools
 *     while ordering every yielded chunk and every promise-returning tool output.
 *   - `normalizeReloadedToolParts` restores Zod/JSON-schema input key order and orders
 *     `output-available` tool outputs while keeping `reasoning.providerMetadata.anthropic.signature`
 *     byte-exact.
 *   - End-to-end live turn vs real Postgres (PGlite `PgChatRepository`) reloaded turn
 *     through `convertToModelMessages` produces IDENTICAL serialized JSON bytes!
 */
import type { PGlite } from "@electric-sql/pglite";
import { convertToModelMessages, tool, type UIMessage } from "ai";
import { drizzle } from "drizzle-orm/pglite";
import { migrate as drizzlePgliteMigrate } from "drizzle-orm/pglite/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import type { MakoPgDb } from "../../database/pg/client";
import {
  generateUuidv7,
  newDualId,
  objectIdToUuid,
} from "../../database/pg/id-codec";
import { resolveMigrationsFolder } from "../../database/pg/migrate";
import * as schema from "../../database/pg/schema";
import { createTestPglite } from "../../database/pg/test-pglite";
import { PgChatRepository } from "../../repositories/chat";
import { convertUIMessageToStoredFormat } from "../agent-thread.service";
import {
  jsonbKeyOrder,
  jsonbOrdered,
  normalizeReloadedToolParts,
  toolNameOfPart,
  withJsonbOrderedOutputs,
} from "./exact-history";

describe("exact-history byte-exact prompt-cache preservation", () => {
  let pg: PGlite;
  let db: MakoPgDb;
  let pgRepo: PgChatRepository;

  const userUuid = generateUuidv7();
  const wsId = newDualId().oid;
  const wsUuid = objectIdToUuid(wsId);

  beforeAll(async () => {
    pg = createTestPglite();
    db = drizzle(pg, { schema }) as unknown as MakoPgDb;
    await drizzlePgliteMigrate(drizzle(pg), {
      migrationsFolder: resolveMigrationsFolder(),
    });
    await pg.query(
      `INSERT INTO users (id, legacy_id, email) VALUES ($1::uuid, $1::text, 'cache@example.com')`,
      [userUuid],
    );
    await pg.query(
      `INSERT INTO workspaces (id, name, slug, created_by) VALUES ($1, 'Cache WS', 'cache-ws', $2)`,
      [wsUuid, userUuid],
    );
    pgRepo = new PgChatRepository({ getDb: () => db });
  });

  afterAll(async () => {
    await pg.close();
  });

  it("jsonbOrdered matches real Postgres jsonb key serialization byte-for-byte", async () => {
    const sample = {
      consoleId: "c1",
      rows: [
        { zebra: 1, a: 2, bb: 3, aa: 4, é: 5, z: 6 },
        { longKeyName: true, id: 10, ok: false },
      ],
      rowCount: 2,
      meta: { b: { zzzz: 1, a: 2 }, a: null },
      omitted: undefined,
    };

    const ordered = jsonbOrdered(sample);
    const pgRes = await pg.query<{ val: unknown }>(`SELECT $1::jsonb AS val`, [
      JSON.stringify(sample),
    ]);

    expect(JSON.stringify(ordered)).toBe(JSON.stringify(pgRes.rows[0].val));
    // Verify comparator directly: shorter UTF-8 byte length wins over ASCII order ("z" < "aa", "zz" (2B) < "é" (2B, 0xc3 > 0x7a))
    expect(jsonbKeyOrder("z", "aa")).toBeLessThan(0);
    expect(jsonbKeyOrder("zz", "é")).toBeLessThan(0);
  });

  it("withJsonbOrderedOutputs wraps async tools and preserves async-iterable streaming tools synchronously", async () => {
    const rawTools = {
      plain_query: {
        execute: async () => ({
          consoleId: "abc",
          rowCount: 1,
          ok: true,
          rows: [{ description: "hello", id: 1 }],
        }),
      },
      streaming_edit: {
        execute: () =>
          (async function* () {
            yield { statusMessage: "working", step: 1, ok: true };
            yield { finalResult: "done", step: 2, id: "x" };
          })(),
      },
      client_only_tool: {
        description: "Runs in browser; no execute",
      },
    };

    const wrapped = withJsonbOrderedOutputs(rawTools);

    // Client-only tool is untouched.
    expect(wrapped.client_only_tool).toBe(rawTools.client_only_tool);

    // Async tool returns jsonb-ordered keys.
    const plainOut = await wrapped.plain_query.execute();
    expect(Object.keys(plainOut as Record<string, unknown>)).toEqual([
      "ok",
      "rows",
      "rowCount",
      "consoleId",
    ]);
    expect(
      Object.keys(
        (plainOut as { rows: Array<Record<string, unknown>> }).rows[0] ?? {},
      ),
    ).toEqual(["id", "description"]);

    // Streaming tool MUST return an AsyncIterable synchronously (NOT a Promise!).
    const stream = wrapped.streaming_edit.execute();
    expect(stream instanceof Promise).toBe(false);
    expect(
      typeof (stream as AsyncIterable<unknown>)[Symbol.asyncIterator],
    ).toBe("function");

    const chunks: unknown[] = [];
    for await (const chunk of stream as AsyncIterable<unknown>) {
      chunks.push(chunk);
    }
    expect(chunks).toHaveLength(2);
    expect(Object.keys(chunks[0] as Record<string, unknown>)).toEqual([
      "ok",
      "step",
      "statusMessage",
    ]);
    expect(Object.keys(chunks[1] as Record<string, unknown>)).toEqual([
      "id",
      "step",
      "finalResult",
    ]);
  });

  it("produces byte-identical model messages between live turn and Postgres-reloaded JSONB history", async () => {
    // Define a real AI SDK tool whose Zod input schema key order deliberately
    // differs from Postgres jsonb key order ("connectionId" (12) before "sql" (3)!).
    const runSqlTool = tool({
      description: "Run SQL query",
      inputSchema: z.object({
        connectionId: z.string(),
        sql: z.string(),
        limit: z.number(),
      }),
      execute: async ({ connectionId, sql: queryText, limit }) => ({
        connectionId,
        queryText,
        rowCount: 1,
        ok: true,
        rows: [{ revenueUsd: 4200, id: 7, country: "CH" }],
        limit,
      }),
    });

    const liveTools = withJsonbOrderedOutputs({ run_sql: runSqlTool });

    // Simulate turn 1 live tool execution (input validated by Zod schema order,
    // output ordered by withJsonbOrderedOutputs).
    const liveInput = {
      connectionId: "conn_123",
      sql: "SELECT 1",
      limit: 50,
    };
    const execFn = liveTools.run_sql.execute;
    if (!execFn) throw new Error("expected run_sql.execute");
    const liveOutput = await execFn(liveInput, {
      toolCallId: "tc-1",
      messages: [],
      context: {},
    });

    const signature =
      "ErUBCkYIBBgCIkB/9xY+AnthropicThinkingSignatureExactBytes0123456789+/==";

    const liveHistory: UIMessage[] = [
      {
        id: "u1",
        role: "user",
        parts: [{ type: "text", text: "Check revenue" }],
      },
      {
        id: "a1",
        role: "assistant",
        parts: [
          {
            type: "reasoning",
            text: "Let me query the database first.",
            providerMetadata: { anthropic: { signature } },
          },
          {
            type: "tool-run_sql",
            toolCallId: "tc-1",
            state: "output-available",
            input: liveInput,
            output: liveOutput,
          } as unknown as UIMessage["parts"][number],
          { type: "text", text: "Revenue is 4200 USD." },
        ],
      },
    ];

    // Persist through real normalized Postgres repository (`chats`, `chat_messages`,
    // `chat_message_parts`, `chat_message_part_metadata`), where jsonb scrambles
    // `tool_input` keys to ["sql", "limit", "connectionId"].
    const chatId = newDualId().oid;
    const stored = liveHistory.map(convertUIMessageToStoredFormat);
    await pgRepo.saveMessages({
      chatId,
      workspaceId: wsId,
      userId: userUuid,
      messages: stored,
    });

    const reloaded = await pgRepo.findById(chatId, wsId);
    if (!reloaded) throw new Error("expected reloaded chat");

    // Verify Postgres actually reordered tool_input keys on disk (so this test is meaningful!).
    const rawToolPart = reloaded.messages[1].parts.find(
      p => p.type === "tool-run_sql",
    );
    if (!rawToolPart) throw new Error("expected tool-run_sql part");
    expect(Object.keys(rawToolPart.input as Record<string, unknown>)).toEqual([
      "sql",
      "limit",
      "connectionId",
    ]);

    // Verify Anthropic thinking signature survived untouched in chat_message_part_metadata.
    const rawReasoningPart = reloaded.messages[1].parts.find(
      p => p.type === "reasoning",
    );
    expect(rawReasoningPart?.providerMetadata).toEqual({
      anthropic: { signature },
    });

    // Convert reloaded StoredChatMessages back to UIMessage shape and normalize.
    const reloadedUiMessages: UIMessage[] = reloaded.messages.map(m => ({
      id: m.id ?? "m",
      role: m.role as "user" | "assistant",
      parts: m.parts.map(p =>
        p.type === "reasoning"
          ? {
              type: "reasoning" as const,
              text: p.reasoning ?? "",
              ...(p.providerMetadata != null
                ? { providerMetadata: p.providerMetadata }
                : {}),
            }
          : p,
      ) as UIMessage["parts"],
    }));

    const normalizedReloaded = await normalizeReloadedToolParts(
      reloadedUiMessages,
      liveTools,
    );

    const liveModelMessages = await convertToModelMessages(liveHistory);
    const reloadedModelMessages =
      await convertToModelMessages(normalizedReloaded);

    // Byte-for-byte prompt cache equality!
    expect(JSON.stringify(reloadedModelMessages)).toBe(
      JSON.stringify(liveModelMessages),
    );
    expect(toolNameOfPart({ type: "tool-run_sql" })).toBe("run_sql");
    expect(
      toolNameOfPart({ type: "dynamic-tool", toolName: "mcp_slack_search" }),
    ).toBe("mcp_slack_search");
    expect(toolNameOfPart({ type: "text" })).toBeNull();
  });
});
