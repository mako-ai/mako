/* eslint-disable no-console, no-process-exit */
/**
 * End-to-end tests for the Postgres-backed OpenAPI router
 * (`routes/pg-persistence.routes.ts`) using `app.request(...)` against a real
 * local Postgres. Auth is stubbed so the router can run without a Mongo session;
 * workspace access is still enforced against the real `workspace_members` table.
 *
 * Run with: tsx src/db/persistence.routes.test.ts
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import { v4 as uuidv4 } from "uuid";

import { eq } from "drizzle-orm";

import { closePostgres, getDb, getPool, pingPostgres } from "./client";
import { objectIdToUuid } from "./ids";
import { runMigrations } from "./migrate";
import {
  chatsRepository,
  connectionsRepository,
  consolesRepository,
  queriesRepository,
  usersRepository,
  workspacesRepository,
} from "./repositories";
import { chats, savedConsoles } from "./schema";
import type { AuthEnv } from "../openapi/core";
import { createPgPersistenceRoutes } from "../routes/pg-persistence.routes";

function fakeObjectId(): string {
  return randomBytes(12).toString("hex");
}

async function main() {
  process.env.ENCRYPTION_KEY =
    process.env.ENCRYPTION_KEY || randomBytes(32).toString("hex");

  assert.ok(await pingPostgres(), "Postgres must be reachable");
  await runMigrations();

  const userId = uuidv4();
  const otherUserId = uuidv4();
  const workspaceId = objectIdToUuid(fakeObjectId());
  const connId = objectIdToUuid(fakeObjectId());
  const consoleId = objectIdToUuid(fakeObjectId());
  const chatId = objectIdToUuid(fakeObjectId());
  const stamp = Date.now();

  // Stub auth: behaves like a logged-in session for `userId`.
  const stubAuth: MiddlewareHandler<AuthEnv> = async (c, next) => {
    c.set("user", { id: userId, email: `route-test-${stamp}@example.com` });
    c.set("authType", "session");
    await next();
  };
  const app = createPgPersistenceRoutes(stubAuth);

  try {
    // ---- seed ----
    await usersRepository.create({
      id: userId,
      email: `route-test-${stamp}@example.com`,
      emailVerified: true,
    });
    await usersRepository.create({
      id: otherUserId,
      email: `route-other-${stamp}@example.com`,
      emailVerified: true,
    });
    await workspacesRepository.create({
      id: workspaceId,
      name: "Route WS",
      slug: `route-ws-${stamp}`,
      createdBy: userId,
    });
    await workspacesRepository.addMember({
      workspaceId,
      userId,
      role: "owner",
    });
    await connectionsRepository.create({
      id: connId,
      workspaceId,
      name: "Routed PG",
      type: "postgresql",
      connection: { host: "h", password: "topsecret" },
      createdBy: userId,
    });
    await consolesRepository.create({
      id: consoleId,
      workspaceId,
      name: "Routed console",
      language: "sql",
      code: "SELECT 1",
      createdBy: userId,
    });
    await chatsRepository.save({
      id: chatId,
      workspaceId,
      title: "Routed chat",
      createdBy: userId,
      threadId: uuidv4(),
      messages: [{ role: "user", parts: [{ type: "text", text: "hi" }] }],
    });
    await queriesRepository.record({
      workspaceId,
      userId,
      connectionId: connId,
      consoleId,
      source: "console",
      databaseType: "postgresql",
      queryLanguage: "sql",
      status: "success",
      rowCount: 1,
      durationMs: 5,
    });

    // ---- health (public) ----
    const health = await app.request("/health");
    assert.equal(health.status, 200);
    const healthJson = (await health.json()) as {
      data: { ok: boolean; backend: string };
    };
    assert.equal(healthJson.data.ok, true);
    assert.equal(healthJson.data.backend, "postgres");

    // ---- connections (credentials redacted) ----
    const connRes = await app.request(`/workspaces/${workspaceId}/connections`);
    assert.equal(connRes.status, 200);
    const connJson = (await connRes.json()) as {
      data: Array<Record<string, unknown>>;
    };
    assert.equal(connJson.data.length, 1);
    assert.equal(connJson.data[0].id, connId);
    assert.equal(connJson.data[0].hasCredentials, true);
    assert.ok(
      !JSON.stringify(connJson.data).includes("topsecret"),
      "credentials must never be exposed by the API",
    );

    // ---- consoles ----
    const consRes = await app.request(`/workspaces/${workspaceId}/consoles`);
    assert.equal(consRes.status, 200);
    const consJson = (await consRes.json()) as { data: Array<{ id: string }> };
    assert.ok(consJson.data.some(x => x.id === consoleId));

    // ---- chats list + detail ----
    const chatsRes = await app.request(`/workspaces/${workspaceId}/chats`);
    assert.equal(chatsRes.status, 200);
    const chatsJson = (await chatsRes.json()) as {
      data: Array<{ id: string }>;
    };
    assert.ok(chatsJson.data.some(x => x.id === chatId));

    const chatRes = await app.request(
      `/workspaces/${workspaceId}/chats/${chatId}`,
    );
    assert.equal(chatRes.status, 200);
    const chatJson = (await chatRes.json()) as {
      data: { id: string; messages: unknown[] };
    };
    assert.equal(chatJson.data.id, chatId);
    assert.equal(chatJson.data.messages.length, 1, "detail includes messages");

    // ---- queries ----
    const qRes = await app.request(`/workspaces/${workspaceId}/queries`);
    assert.equal(qRes.status, 200);
    const qJson = (await qRes.json()) as { data: unknown[] };
    assert.equal(qJson.data.length, 1);

    // ---- 404 for unknown chat ----
    const missing = await app.request(
      `/workspaces/${workspaceId}/chats/${objectIdToUuid(fakeObjectId())}`,
    );
    assert.equal(missing.status, 404);

    // ---- 403 for a workspace the user is not a member of ----
    const otherWs = objectIdToUuid(fakeObjectId());
    await workspacesRepository.create({
      id: otherWs,
      name: "Other WS",
      slug: `other-ws-${stamp}`,
      createdBy: otherUserId,
    });
    const forbidden = await app.request(`/workspaces/${otherWs}/connections`);
    assert.equal(forbidden.status, 403, "non-member must be denied");
    await workspacesRepository.delete(otherWs).catch(() => undefined);

    console.log(
      "persistence.routes.test: OK — OpenAPI router serves Postgres data with workspace auth",
    );
  } finally {
    await getDb().delete(chats).where(eq(chats.workspaceId, workspaceId));
    await getDb()
      .delete(savedConsoles)
      .where(eq(savedConsoles.workspaceId, workspaceId));
    await getPool().query(
      "DELETE FROM query_executions WHERE workspace_id = $1",
      [workspaceId],
    );
    await workspacesRepository.delete(workspaceId).catch(() => undefined);
    await usersRepository.delete(userId).catch(() => undefined);
    await usersRepository.delete(otherUserId).catch(() => undefined);
    await closePostgres();
  }
  process.exit(0);
}

main().catch(err => {
  console.error("persistence.routes.test: FAILED", err);
  process.exit(1);
});
