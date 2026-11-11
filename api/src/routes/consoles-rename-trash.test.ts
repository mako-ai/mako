/**
 * The console routes a rename, a move, a delete and an Undo go through,
 * over HTTP against real git and Mongo: what each answers when it is
 * refused (a name no file can have, a place that is taken, a change of
 * who sees it that is not the caller's, a console in the trash) and what
 * it says it did (the name as saved, what a folder delete trashed).
 */
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { Hono } from "hono";

const auth = vi.hoisted(() => ({
  userId: "",
  roles: {} as Record<string, string>,
}));
vi.mock("../auth/unified-auth.middleware", () => ({
  unifiedAuthMiddleware: async (
    c: { set: (k: string, v: unknown) => void },
    next: () => Promise<void>,
  ) => {
    c.set("authType", "session");
    c.set("user", { id: auth.userId });
    await next();
  },
  isSessionAuth: () => true,
}));
vi.mock("../services/workspace.service", () => ({
  workspaceService: {
    getMember: vi.fn(async (_ws: string, userId: string) => ({
      role: auth.roles[userId] ?? "member",
    })),
    hasRole: vi.fn(async (_ws: string, userId: string, roles: string[]) =>
      roles.includes(auth.roles[userId] ?? "member"),
    ),
  },
}));

import { consoleRoutes } from "./consoles";
import { SavedConsole } from "../database/workspace-schema";
import {
  ALICE,
  BOB,
  WS,
  consoleFiles,
  manager,
  resetRig,
  row,
  save,
  startRig,
  stopRig,
} from "../apps/console-test-rig";

const app = new Hono();
app.route("/api/workspaces/:workspaceId/consoles", consoleRoutes);

async function call(
  method: string,
  path: string,
  body?: unknown,
  as: string = ALICE,
): Promise<{ status: number; json: Record<string, any> }> {
  auth.userId = as;
  const res = await app.request(`/api/workspaces/${WS}/consoles${path}`, {
    method,
    ...(body === undefined
      ? {}
      : {
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
  });
  return {
    status: res.status,
    json: (await res.json()) as Record<string, any>,
  };
}

beforeAll(startRig);
afterAll(stopRig);
beforeEach(async () => {
  auth.roles = {};
  await resetRig();
});

describe("PATCH /{id}/rename and /{id}/move", () => {
  it("answers with the name as saved, and refuses with the reason", async () => {
    const id = (await save("a"))._id.toString();
    await save("taken");

    const renamed = await call("PATCH", `/${id}/rename`, {
      name: "Q1: revenue",
    });
    expect(renamed.status).toBe(200);
    expect(renamed.json.data).toMatchObject({
      id,
      name: "Q1 - revenue",
      path: "Q1 - revenue",
      folderId: null,
      access: "workspace",
    });

    const clash = await call("PATCH", `/${id}/rename`, { name: "Taken" });
    expect(clash.status).toBe(409);
    expect(clash.json.error).toMatch(/already exists/);
    const bad = await call("PATCH", `/${id}/rename`, { name: "con" });
    expect(bad.status).toBe(400);
    expect(bad.json.error).toMatch(/reserved/);
    expect(await consoleFiles()).toEqual([
      "consoles/Q1 - revenue.sql",
      "consoles/taken.sql",
    ]);
  });

  it("moves and renames in one request; a change of who sees it is the owner's or an admin's", async () => {
    const folder = await call("POST", "/folders", {
      name: "Team: A",
      access: "workspace",
    });
    expect(folder.status).toBe(201);
    expect(folder.json.data.name).toBe("Team - A");
    const folderId = folder.json.data.id as string;

    const mine = await save("mine", "SELECT 1", { access: "private" });
    const id = mine._id.toString();
    await SavedConsole.updateOne(
      { _id: id },
      { $set: { sharedWith: [{ userId: BOB, role: "editor" }] } },
    );
    const refused = await call("PATCH", `/${id}/move`, { folderId }, BOB);
    expect(refused.status).toBe(403);
    expect(refused.json.error).toMatch(/owner or a workspace admin/);

    const moved = await call("PATCH", `/${id}/move`, {
      folderId,
      name: "ours",
    });
    expect(moved.status).toBe(200);
    expect(moved.json.data).toMatchObject({
      name: "ours",
      path: "Team - A/ours",
      folderId,
      access: "workspace",
    });
    expect(await consoleFiles()).toEqual([
      "users/alice/consoles/Team - A/ours.sql",
    ]);
  });
});

describe("DELETE, then Undo", () => {
  it("a console goes to the trash and comes back; one in the trash is not renamed", async () => {
    const id = (await save("a"))._id.toString();
    expect((await call("DELETE", `/${id}`)).status).toBe(200);
    expect(await consoleFiles()).toEqual([]);
    expect((await call("PATCH", `/${id}/rename`, { name: "b" })).status).toBe(
      404,
    );
    expect((await call("DELETE", `/${id}`)).status).toBe(404);

    // Only whoever could delete it may take it out of the trash.
    expect((await call("PATCH", `/${id}/restore`, {}, BOB)).status).toBe(403);
    await save("A", "SELECT 'taken'");
    const restored = await call("PATCH", `/${id}/restore`);
    expect(restored.status).toBe(200);
    expect(restored.json.data).toMatchObject({ id, name: "a (2)" });
    expect((await call("PATCH", `/${id}/restore`)).status).toBe(404);
  });

  it("a folder's consoles go to the trash; the answer is what its Undo puts back", async () => {
    const folderId = (
      await call("POST", "/folders", { name: "Team", access: "workspace" })
    ).json.data.id as string;
    const mine = await save("mine");
    const theirs = await save("theirs", "SELECT 2", { by: BOB });
    await manager.moveConsole(
      mine._id.toString(),
      WS,
      folderId,
      undefined,
      ALICE,
    );
    await manager.moveConsole(
      theirs._id.toString(),
      WS,
      folderId,
      undefined,
      BOB,
    );

    const refused = await call("DELETE", `/folders/${folderId}`);
    expect(refused.status).toBe(403);
    expect(refused.json.error).toMatch(/other members/);
    expect((await consoleFiles()).length).toBe(2);

    auth.roles[ALICE] = "admin";
    const deleted = await call("DELETE", `/folders/${folderId}`);
    expect(deleted.status).toBe(200);
    expect(deleted.json.data.folders).toEqual([
      { id: folderId, name: "Team", parentId: null, access: "workspace" },
    ]);
    expect(
      (deleted.json.data.consoles as Array<{ name: string }>)
        .map(c => c.name)
        .sort(),
    ).toEqual(["mine", "theirs"]);
    expect(await consoleFiles()).toEqual([]);
    expect((await row(theirs._id))?.is_deleted).toBe(true);

    // Undo: the folder again, each console restored into it.
    const again = (
      await call("POST", "/folders", { name: "Team", access: "workspace" })
    ).json.data.id as string;
    const back = await call("PATCH", `/${mine._id.toString()}/restore`, {
      folderId: again,
    });
    expect(back.json.data).toMatchObject({
      name: "mine",
      path: "Team/mine",
      folderId: again,
    });
    expect(await consoleFiles()).toEqual(["consoles/Team/mine.sql"]);
  });
});
