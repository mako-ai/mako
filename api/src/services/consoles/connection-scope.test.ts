/**
 * A console may only use a database connection of its own
 * workspace. Workspace A knows workspace B's connection id (ids are not
 * secrets); every entry point that stores or runs a connectionId must
 * refuse it:
 *
 * - POST /consoles and PUT /consoles/:pathOrId (save.ts): 404;
 * - create_console / set_console_connection (agent + MCP tools): refused;
 * - the scheduled runner: a stored foreign id fails the run, nothing runs;
 * - console search: never names another workspace's connection.
 *
 * The console repo-push reactor and version restore are covered in
 * workspace-consoles.service.test.ts. Flows: flow-connection-scope.test.ts.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { Types } from "mongoose";
import {
  type PgTestDb,
  setupPgTestDb,
  ensureTestUser,
  ensureTestDatabaseConnection,
} from "../../test-support/pg-test";

vi.mock("../../integrations/github/app-auth", () => ({
  resolveRepoToken: async () => undefined,
}));
vi.mock("../../inngest/client", () => ({
  inngest: {
    send: vi.fn(async () => undefined),
    createFunction: vi.fn(() => ({})),
  },
}));

import { consolesChartsRepo } from "../../repositories/consoles-charts";
import { generateUuidv7 } from "../../database/pg/id-codec";
import { savedConsoles } from "../../database/pg/schema";
import { initRepo, repoDirFor } from "../../apps/repository.service";
import { bindTestWorkspaceRepo } from "../../apps/bind-test-workspace-repo";
import {
  createConsoleAtPath,
  saveConsoleById,
  saveConsoleByPath,
} from "./save";
import {
  FOREIGN_CONNECTION_ERROR,
  connectionIdAllowed,
  workspaceOwnsConnection,
} from "./connection-scope";
import { loadScheduledConsole } from "../../inngest/functions/scheduled-query";
import { enrichWithConnectionNames } from "../../agent-lib/tools/console-search-tools";
import { createServerConsoleTools } from "../../agent-lib/tools/server-console-tools";

let pg: PgTestDb;
let tmpRoot: string;
let WS: string;
let OTHER_WS: string;
let OWN: string;
let FOREIGN: string;
const USER = { id: generateUuidv7(), email: "a@example.com" };

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "console-scope-"));
  process.env.APPS_GIT_ROOT = path.join(tmpRoot, "repos");
  process.env.APPS_SESSIONS_ROOT = path.join(tmpRoot, "sessions");
  pg = await setupPgTestDb();
}, 120_000);

afterAll(async () => {
  await pg?.close();
  await fs.rm(tmpRoot, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
});

beforeEach(async () => {
  WS = new Types.ObjectId().toString();
  OTHER_WS = new Types.ObjectId().toString();
  OWN = new Types.ObjectId().toString();
  FOREIGN = new Types.ObjectId().toString();
  await pg.reset();
  await ensureTestUser(pg.db, USER);
  await initRepo(repoDirFor(WS), { "README.md": "x\n" });
  await bindTestWorkspaceRepo(WS);
  await ensureTestDatabaseConnection(pg.db, {
    workspaceId: WS,
    id: OWN,
    name: `db-${OWN}`,
  });
  await ensureTestDatabaseConnection(pg.db, {
    workspaceId: OTHER_WS,
    id: FOREIGN,
    name: `db-${FOREIGN}`,
  });
});

/** A console row in WS pointing at `connectionId`, as an old write left it. */
async function consoleRow(connectionId: string) {
  return consolesChartsRepo.createConsole({
    workspaceId: WS,
    name: "nightly",
    code: "DELETE FROM customers",
    language: "sql",
    connectionId,
    createdBy: USER.id,
    owner_id: USER.id,
    isSaved: true,
    access: "workspace",
    isPrivate: false,
    executionCount: 0,
    schedule: { cron: "* * * * *", timezone: "UTC" },
  });
}

describe("connection-scope helpers", () => {
  it("own id is allowed; foreign, malformed and object ids are not", async () => {
    expect(await workspaceOwnsConnection(WS, OWN)).toBe(true);
    expect(await workspaceOwnsConnection(WS, FOREIGN)).toBe(false);
    expect(await workspaceOwnsConnection(WS, "not-an-id")).toBe(false);
    expect(await workspaceOwnsConnection(WS, { id: FOREIGN })).toBe(false);
    expect(await connectionIdAllowed(WS, undefined)).toBe(true);
    expect(await connectionIdAllowed(WS, "")).toBe(true);
    expect(await connectionIdAllowed(WS, FOREIGN)).toBe(false);
    expect(await connectionIdAllowed(WS, "not-an-id")).toBe(false);
    // A deleted connection's id runs nowhere: the editor may keep sending it.
    expect(await connectionIdAllowed(WS, new Types.ObjectId().toString())).toBe(
      true,
    );
  });
});

describe("POST /consoles and PUT /consoles/:pathOrId", () => {
  it("POST with a foreign connectionId is a 404 and writes nothing", async () => {
    const result = await createConsoleAtPath({
      workspaceId: WS,
      user: USER,
      path: "steal",
      content: "DELETE FROM customers",
      connectionId: FOREIGN,
    });
    expect(result).toEqual({
      ok: false,
      status: 404,
      error: FOREIGN_CONNECTION_ERROR,
    });
    expect(await pg.db.$count(savedConsoles)).toBe(0);
  });

  it("POST with an own connectionId saves it", async () => {
    const result = await createConsoleAtPath({
      workspaceId: WS,
      user: USER,
      path: "mine",
      content: "SELECT 1",
      connectionId: OWN,
    });
    expect(result.ok).toBe(true);
    const row = await consolesChartsRepo.findConsoleByNameAndFolder(
      WS,
      "mine",
      null,
    );
    expect(row?.connectionId?.toString()).toBe(OWN);
  });

  it("PUT by path with a foreign connectionId is a 404", async () => {
    const result = await saveConsoleByPath({
      workspaceId: WS,
      user: USER,
      path: "Finance/steal",
      body: { content: "SELECT 1", connectionId: FOREIGN },
    });
    expect(result).toMatchObject({ ok: false, status: 404 });
    expect(await pg.db.$count(savedConsoles)).toBe(0);
  });

  it("PUT by id (draft autosave and explicit save) with a foreign connectionId is a 404", async () => {
    const own = await consoleRow(OWN);
    for (const isSaved of [false, true]) {
      const result = await saveConsoleById({
        workspaceId: WS,
        consoleId: own._id.toString(),
        user: USER,
        memberRole: "admin",
        body: { content: "SELECT 2", connectionId: FOREIGN, isSaved },
      });
      expect(result).toMatchObject({ ok: false, status: 404 });
    }
    // A brand-new id (upsert) is refused too.
    const fresh = await saveConsoleById({
      workspaceId: WS,
      consoleId: new Types.ObjectId().toString(),
      user: USER,
      memberRole: "admin",
      body: { content: "SELECT 3", connectionId: FOREIGN },
    });
    expect(fresh).toMatchObject({ ok: false, status: 404 });
    expect(await pg.db.$count(savedConsoles)).toBe(1);
    const rows = await consolesChartsRepo.listConsolesByWorkspace(WS);
    expect(rows).toHaveLength(1);
    expect(rows[0].connectionId?.toString()).toBe(OWN);
  });
});

describe("autosave keeps working for a console whose connection was deleted", () => {
  it("PUT by id with a deleted connection id saves", async () => {
    const deleted = new Types.ObjectId().toString();
    const own = await consoleRow(OWN);
    const result = await saveConsoleById({
      workspaceId: WS,
      consoleId: own._id.toString(),
      user: USER,
      memberRole: "admin",
      body: { content: "SELECT 9", connectionId: deleted },
    });
    expect(result.ok).toBe(true);
  });
});

describe("agent and MCP console tools", () => {
  const ctx = { toolCallId: "t", messages: [] } as never;

  it("create_console refuses a foreign connectionId", async () => {
    const tools = createServerConsoleTools({ workspaceId: WS });
    const result = (await tools.create_console.execute?.(
      { title: "steal", content: "SELECT 1", connectionId: FOREIGN } as never,
      ctx,
    )) as { success: boolean; error?: string };
    expect(result.success).toBe(false);
    expect(result.error).toContain("not found in this workspace");
    expect(await pg.db.$count(savedConsoles)).toBe(0);
  });

  it("set_console_connection refuses a foreign connectionId", async () => {
    const own = await consoleRow(OWN);
    const tools = createServerConsoleTools({ workspaceId: WS });
    const result = (await tools.set_console_connection.execute?.(
      { consoleId: own._id.toString(), connectionId: FOREIGN } as never,
      ctx,
    )) as { success: boolean; error?: string };
    expect(result.success).toBe(false);
    expect(result.error).toContain("not found in this workspace");
    const after = await consolesChartsRepo.findConsoleById(WS, own.id);
    expect(after?.connectionId?.toString()).toBe(OWN);
  });
});

describe("scheduled runner", () => {
  it("refuses to run a console whose stored connectionId is foreign", async () => {
    const row = await consoleRow(FOREIGN);
    await expect(loadScheduledConsole(WS, row._id.toString())).rejects.toThrow(
      /not in this workspace; refusing to run/,
    );
  });

  it("loads an own connection", async () => {
    const row = await consoleRow(OWN);
    const loaded = await loadScheduledConsole(WS, row._id.toString());
    expect(String(loaded.connection._id)).toBe(OWN);
  });

  it("a console of another workspace is not found", async () => {
    const row = await consoleRow(OWN);
    await expect(
      loadScheduledConsole(OTHER_WS, row._id.toString()),
    ).rejects.toThrow(/not found/);
  });
});

describe("console search", () => {
  it("names only this workspace's connections", async () => {
    const results = [
      { id: "1", connectionId: OWN },
      { id: "2", connectionId: FOREIGN },
    ] as never[];
    await enrichWithConnectionNames(results, WS);
    const named = results as Array<{ connectionName?: string }>;
    expect(named[0].connectionName).toBe(`db-${OWN}`);
    expect(named[1].connectionName).toBeUndefined();
  });
});
