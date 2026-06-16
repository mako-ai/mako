/* eslint-disable no-console, no-process-exit */
/**
 * Integration tests for the Drizzle repository layer against a real Postgres.
 *
 * Requires a running Postgres (POSTGRES_URL or local default) and ENCRYPTION_KEY.
 * Run with: tsx src/db/repositories.test.ts
 *
 * Exercises the full dependency chain auth -> workspaces -> connections ->
 * consoles -> chats -> queries, verifying typed CRUD, foreign keys, credential
 * encryption round-trips, and ObjectId-derived uuid keys.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { v4 as uuidv4 } from "uuid";

import { eq } from "drizzle-orm";

import { closePostgres, getDb, getPool, pingPostgres } from "./client";
import { decrypt } from "./crypto";
import { objectIdToUuid } from "./ids";
import { runMigrations } from "./migrate";
import {
  chatsRepository,
  connectionsRepository,
  consolesRepository,
  queriesRepository,
  sessionsRepository,
  usersRepository,
  workspacesRepository,
} from "./repositories";
import { chats, databaseConnections, savedConsoles } from "./schema";

function fakeObjectId(): string {
  return randomBytes(12).toString("hex");
}

async function main() {
  process.env.ENCRYPTION_KEY =
    process.env.ENCRYPTION_KEY || randomBytes(32).toString("hex");

  assert.ok(await pingPostgres(), "Postgres must be reachable");
  await runMigrations();

  // Unique ids for this run.
  const userId = uuidv4();
  const workspaceId = objectIdToUuid(fakeObjectId());
  const connId = objectIdToUuid(fakeObjectId());
  const consoleId = objectIdToUuid(fakeObjectId());
  const chatId = objectIdToUuid(fakeObjectId());
  const email = `repo-test-${Date.now()}@example.com`;

  try {
    // ---- users ----
    const user = await usersRepository.create({
      id: userId,
      email,
      hashedPassword: "hashed",
      emailVerified: true,
    });
    assert.equal(user.id, userId);
    assert.equal(user.email, email.toLowerCase());

    const byEmail = await usersRepository.findByEmail(email.toUpperCase());
    assert.equal(byEmail?.id, userId, "case-insensitive email lookup");

    await usersRepository.update(userId, {
      onboarding: { role: "engineer", companySize: "startup" },
    });
    const updated = await usersRepository.findById(userId);
    assert.equal(updated?.onboarding?.role, "engineer", "jsonb onboarding");

    // ---- sessions ----
    const sessionId = randomBytes(32).toString("hex");
    await sessionsRepository.create({
      id: sessionId,
      userId,
      expiresAt: new Date(Date.now() + 3600_000),
    });
    const withUser = await sessionsRepository.findWithUser(sessionId);
    assert.equal(withUser?.user.id, userId, "session join returns user");

    // ---- workspaces + members ----
    const ws = await workspacesRepository.create({
      id: workspaceId,
      name: "Repo Test WS",
      slug: `repo-test-${Date.now()}`,
      createdBy: userId,
      settings: { maxDatabases: 5 },
    });
    assert.equal(ws.id, workspaceId);
    assert.equal(ws.settings?.maxDatabases, 5, "jsonb settings");

    await workspacesRepository.addMember({
      workspaceId,
      userId,
      role: "owner",
    });
    assert.ok(
      await workspacesRepository.hasAccess(workspaceId, userId),
      "member has access",
    );
    const listed = await workspacesRepository.listForUser(userId);
    assert.ok(
      listed.some(w => w.id === workspaceId),
      "workspace appears in user list",
    );

    // ---- connections (encryption round-trip) ----
    const secret = "super-secret-password";
    const conn = await connectionsRepository.create({
      id: connId,
      workspaceId,
      name: "Test PG",
      type: "postgresql",
      connection: { host: "db.example.com", port: 5432, password: secret },
      createdBy: userId,
    });
    assert.equal(
      (conn.connection as Record<string, unknown>).password,
      secret,
      "repository returns plaintext password",
    );
    // Raw row must be ciphertext, not plaintext.
    const rawRows = await getDb()
      .select()
      .from(databaseConnections)
      .where(eq(databaseConnections.id, connId));
    const rawPwd = (rawRows[0].connection as Record<string, string>).password;
    assert.notEqual(rawPwd, secret, "stored password must be encrypted");
    assert.equal(decrypt(rawPwd), secret, "ciphertext decrypts to original");

    const fetchedConn = await connectionsRepository.findById(connId);
    assert.equal(
      (fetchedConn?.connection as Record<string, unknown>).password,
      secret,
      "findById decrypts password",
    );

    // ---- consoles (FK to connection) ----
    const cons = await consolesRepository.create({
      id: consoleId,
      workspaceId,
      connectionId: connId,
      name: "My Console",
      language: "sql",
      code: "SELECT 1",
      createdBy: userId,
    });
    assert.equal(cons.connectionId, connId, "console FK to connection");
    const consList = await consolesRepository.listForWorkspace(workspaceId);
    assert.ok(consList.some(x => x.id === consoleId));
    await consolesRepository.softDelete(consoleId);
    const afterSoftDelete =
      await consolesRepository.listForWorkspace(workspaceId);
    assert.ok(
      !afterSoftDelete.some(x => x.id === consoleId),
      "soft-deleted console excluded from list",
    );

    // ---- chats (messages jsonb + full-thread upsert) ----
    const chat = await chatsRepository.save({
      id: chatId,
      workspaceId,
      title: "First chat",
      createdBy: userId,
      threadId: uuidv4(),
      messages: [
        { role: "user", parts: [{ type: "text", text: "hello" }] },
        {
          role: "assistant",
          parts: [{ type: "text", text: "hi!" }],
        },
      ],
    });
    assert.equal(chat.messages.length, 2, "messages persisted");
    // saveChat-style update replaces the thread.
    await chatsRepository.save({
      id: chatId,
      workspaceId,
      title: "Renamed chat",
      createdBy: userId,
      messages: [
        { role: "user", parts: [{ type: "text", text: "hello" }] },
        { role: "assistant", parts: [{ type: "text", text: "updated" }] },
        { role: "user", parts: [{ type: "text", text: "more" }] },
      ],
    });
    const reloaded = await chatsRepository.findById(chatId);
    assert.equal(reloaded?.title, "Renamed chat");
    assert.equal(reloaded?.messages.length, 3, "upsert replaced messages");
    const chatList = await chatsRepository.listForWorkspace(workspaceId);
    assert.ok(
      chatList.some(c => c.id === chatId),
      "chat appears in workspace list",
    );
    // List must omit the heavy messages blob.
    assert.ok(
      !("messages" in (chatList.find(c => c.id === chatId) ?? {})),
      "list omits messages",
    );

    // ---- query executions ----
    const qe = await queriesRepository.record({
      workspaceId,
      userId,
      connectionId: connId,
      consoleId,
      source: "console",
      databaseType: "postgresql",
      queryLanguage: "sql",
      status: "success",
      rowCount: 1,
      durationMs: 12,
    });
    assert.ok(qe.id, "query execution recorded");
    const qeList = await queriesRepository.listForWorkspace(workspaceId);
    assert.ok(qeList.some(q => q.id === qe.id));

    console.log(
      "repositories.test: OK — auth->workspaces->connections->consoles->chats->queries CRUD verified",
    );
  } finally {
    // Cleanup (children first; FKs cascade from workspace/user too).
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
    await closePostgres();
  }
  process.exit(0);
}

main().catch(err => {
  console.error("repositories.test: FAILED", err);
  process.exit(1);
});
