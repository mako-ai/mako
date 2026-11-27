import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  generateObjectIdHex,
  generateUuidv7,
  isUuidString,
  legacyUserIdToUuidv7,
  objectIdToUuid,
} from "../database/pg/id-codec";
import {
  appsMetadataRepo,
  type AppProjectRecord,
} from "../repositories/apps-metadata";
import {
  ensureTestMember,
  ensureTestUser,
  ensureTestWorkspace,
  setupPgTestDb,
  type PgTestDb,
} from "../test-support/pg-test";
import type { Context, Next } from "hono";
import { asc, eq } from "drizzle-orm";
import { appUsageDaily, appUsageEvents } from "../database/pg/schema";
import { workspaceRepo } from "../repositories/workspaces";

// Supply an authenticated identity; keep membership, ACLs, persistence and
// the mounted sharing routes real so a missing role cannot pass unnoticed.
const identity = vi.hoisted(() => ({ userId: "admin" }));
vi.mock("../auth/unified-auth.middleware", () => ({
  unifiedAuthMiddleware: async (c: Context, next: Next) => {
    c.set("user", {
      id: isUuidString(identity.userId)
        ? identity.userId
        : legacyUserIdToUuidv7(identity.userId),
      email: `${identity.userId}@example.com`,
    });
    await next();
  },
}));

import { createRouter } from "../openapi/core";
import { appsRoutes } from "../routes/apps";
import { publicShareRoutes, recordSharedAppOpen } from "../routes/public-share";
import { anonIdFromCookie, resetUsageThrottle } from "./app-usage.service";
import { invalidateOwnerDirectory } from "./user-handles.service";

const app = createRouter();
app.route("/api/workspaces/:workspaceId/apps", appsRoutes);
app.route("/api/share", publicShareRoutes);

const workspaceId = generateObjectIdHex();
let pg: PgTestDb;
let project: AppProjectRecord;

beforeAll(async () => {
  vi.stubEnv("ENCRYPTION_KEY", "ab".repeat(32));
  vi.stubEnv("SESSION_SECRET", "sharing-route-test-secret");
  vi.stubEnv("BCRYPT_ROUNDS", "4");
  pg = await setupPgTestDb();
});

beforeEach(async () => {
  identity.userId = "admin";
  await pg.reset();
  await ensureTestWorkspace(pg.db, { id: workspaceId, name: "Sharing test" });
  for (const id of [
    "admin",
    "owner",
    "member",
    "viewer",
    "app-owner",
    "newcomer",
  ]) {
    await ensureTestUser(pg.db, { id, email: `${id}@example.com` });
  }
  for (const role of ["admin", "owner", "member", "viewer"] as const) {
    await ensureTestMember(pg.db, { workspaceId, userId: role, role });
  }
  project = await appsMetadataRepo.createProject({
    workspaceId,
    title: "Financial Model",
    slug: "financial-model",
    access: "workspace",
    owner_id: "app-owner",
    createdBy: "app-owner",
  });
});

afterAll(async () => {
  await pg?.close();
  vi.unstubAllEnvs();
});

function manage(suffix: string, method: string, body?: object) {
  return app.request(
    `/api/workspaces/${workspaceId}/apps/${project.id}/${suffix}`,
    {
      method,
      ...(body
        ? {
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          }
        : {}),
    },
  );
}

describe("app sharing authorization", () => {
  it.each(["admin", "owner"])(
    "lets a workspace %s protect another person's app",
    async userId => {
      identity.userId = userId;
      const response = await manage("public-share", "POST", {
        password: "test-password",
      });
      expect(response.status).toBe(200);
      const { data } = (await response.json()) as {
        data: { token: string };
      };
      expect(data).toMatchObject({ enabled: true, hasPassword: true });
      expect(JSON.stringify(data)).not.toContain("test-password");

      const locked = await app.request(`/api/share/${data.token}/content`);
      expect(locked.status).toBe(401);
      const wrong = await app.request(`/api/share/${data.token}/unlock`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: "wrong" }),
      });
      expect(wrong.status).toBe(401);
      const unlock = await app.request(`/api/share/${data.token}/unlock`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: "test-password" }),
      });
      expect(unlock.status).toBe(200);
      const cookie = unlock.headers.get("set-cookie")?.split(";")[0];
      expect(cookie).toBeTruthy();
      const content = await app.request(`/api/share/${data.token}/content`, {
        headers: { Cookie: cookie ?? "" },
      });
      expect(content.status).toBe(200);
      expect(((await content.json()) as { data: unknown }).data).toMatchObject({
        kind: "app",
        title: "Financial Model",
      });
    },
  );

  it("lets admins manage workspace access and collaborators", async () => {
    expect(
      (await manage("sharing", "PATCH", { workspaceRole: "editor" })).status,
    ).toBe(200);
    expect(
      (
        await manage("collaborators", "POST", {
          userId: legacyUserIdToUuidv7("viewer"),
          role: "viewer",
        })
      ).status,
    ).toBe(200);
    const saved = await appsMetadataRepo.findProjectById(project.id);
    expect(saved?.workspaceRole).toBe("editor");
    expect(saved?.sharedWith?.map(entry => entry.userId)).toContain(
      legacyUserIdToUuidv7("viewer"),
    );
  });

  it.each(["member", "viewer"])(
    "rejects public sharing by a workspace %s",
    async userId => {
      identity.userId = userId;
      expect(
        (await manage("public-share", "POST", { password: "test-password" }))
          .status,
      ).toBe(403);
      expect(
        (await appsMetadataRepo.findProjectById(project.id))?.publicShare
          ?.enabled,
      ).not.toBe(true);
    },
  );

  it("does not let admins share another person's private app", async () => {
    await appsMetadataRepo.updateProjectSharing(workspaceId, project.id, {
      access: "private",
    });
    expect(
      (await manage("public-share", "POST", { password: "test-password" }))
        .status,
    ).toBe(403);
  });

  it("rejects a user outside the workspace", async () => {
    identity.userId = "outsider";
    expect(
      (await manage("public-share", "POST", { password: "test-password" }))
        .status,
    ).toBe(403);
  });

  it("preserves domain auto-join without granting sharing rights", async () => {
    identity.userId = "newcomer";
    await workspaceRepo.setAutoJoin(workspaceId, {
      domains: ["example.com"],
      role: "viewer",
    });
    expect((await manage("collaborators", "GET")).status).toBe(200);
    expect(
      (await workspaceRepo.findMember(workspaceId, "newcomer"))?.role,
    ).toBe("viewer");
    expect(
      (await manage("public-share", "POST", { password: "test-password" }))
        .status,
    ).toBe(403);
  });
});

describe("a personal app's row, through the sharing routes", () => {
  const carol = generateUuidv7();
  const someone = generateUuidv7();
  const wsAdmin = generateUuidv7();

  beforeEach(async () => {
    await ensureTestUser(pg.db, { id: carol, email: "carol@example.com" });
    await ensureTestUser(pg.db, { id: someone, email: "someone@example.com" });
    await ensureTestUser(pg.db, { id: wsAdmin, email: "ws-admin@example.com" });
    await ensureTestMember(pg.db, { workspaceId, userId: carol });
    await ensureTestMember(pg.db, { workspaceId, userId: someone });
    await ensureTestMember(pg.db, {
      workspaceId,
      userId: wsAdmin,
      role: "admin",
    });
    invalidateOwnerDirectory();
  });

  const row = (path: string) =>
    appsMetadataRepo.createProject({
      workspaceId,
      title: "Personal",
      slug: path.split("/").pop(),
      path,
      access: "private",
      createdBy: "",
    });
  const refused = async (userId: string) => {
    identity.userId = userId;
    const calls = [
      await manage("public-share", "POST", { password: "test-password" }),
      await manage("sharing", "PATCH", { access: "workspace" }),
      await manage("collaborators", "POST", { userId, role: "editor" }),
      await manage("chat", "PATCH", { enabled: true }),
    ];
    return calls.map(call => call.status);
  };

  it.each([
    ["a member", () => someone],
    ["an admin", () => wsAdmin],
  ])(
    "an ownerless row under a handle goes to the handle's owner when %s calls",
    async (_role, actor) => {
      project = await row("users/carol/apps/pushed");
      expect(await refused(actor())).toEqual([403, 403, 403, 403]);
      const saved = await appsMetadataRepo.findProjectById(project.id);
      expect(saved?.owner_id).toBe(carol);
      expect(saved?.access).toBe("private");
      expect(saved?.publicShare?.enabled ?? false).toBe(false);
      expect(saved?.sharedWith ?? []).toEqual([]);

      identity.userId = carol;
      expect((await manage("chat", "PATCH", { enabled: true })).status).toBe(
        200,
      );
    },
  );

  it.each([
    ["a member", () => someone],
    ["an admin", () => wsAdmin],
  ])(
    "a row under a handle nobody holds stays ownerless when %s calls",
    async (_role, actor) => {
      project = await row("users/nobody/apps/orphan");
      expect(await refused(actor())).toEqual([403, 403, 403, 403]);
      const saved = await appsMetadataRepo.findProjectById(project.id);
      expect(saved?.owner_id ?? undefined).toBeUndefined();
      expect(saved?.createdBy || undefined).toBeUndefined();
    },
  );
});

describe("anonymous share viewers (usage)", () => {
  // The share route's open recording, on a stand-in for the served entry:
  // the real one needs a built deployment in the artifact store.
  const APP_ID = generateObjectIdHex();
  const probe = createRouter();
  probe.get("/api/share/t/app/", c => {
    const response = new Response("<!doctype html>", {
      headers: { "Content-Type": "text/html" },
    });
    recordSharedAppOpen(c, response, workspaceId.toString(), APP_ID);
    return response;
  });
  const load = (headers: Record<string, string>) =>
    probe.request("/api/share/t/app/", { headers });
  const events = () =>
    pg.db
      .select()
      .from(appUsageEvents)
      .where(eq(appUsageEvents.appId, objectIdToUuid(APP_ID)))
      .orderBy(asc(appUsageEvents.at));

  beforeEach(() => resetUsageThrottle());

  it("gives a first-time viewer a cookie and records only its hash", async () => {
    const first = await load({ "sec-fetch-dest": "document" });
    const setCookie = first.headers.get("set-cookie") ?? "";
    const cookie = /mako_viewer=([^;]+)/.exec(setCookie)?.[1] ?? "";
    expect(cookie).toBeTruthy();
    expect(setCookie).toContain("HttpOnly");
    await vi.waitFor(async () => expect(await events()).toHaveLength(1));
    const [event] = await events();
    expect(event.anonId).toBe(anonIdFromCookie(cookie));
    expect(JSON.stringify(event)).not.toContain(cookie);

    // The same browser later, from another network: same id, no new cookie.
    resetUsageThrottle();
    const again = await load({
      "sec-fetch-dest": "document",
      Cookie: `mako_viewer=${cookie}`,
      "x-forwarded-for": "203.0.113.9",
    });
    expect(again.headers.get("set-cookie")).toBeNull();
    await vi.waitFor(async () => expect(await events()).toHaveLength(2));
    expect(new Set((await events()).map(e => e.anonId)).size).toBe(1);
  });

  it("does not trust a frame's first view to be identifiable", async () => {
    await load({ "sec-fetch-dest": "iframe" });
    await vi.waitFor(async () => expect(await events()).toHaveLength(1));
    expect((await events())[0]).toMatchObject({
      source: "embed",
      anonId: null,
    });
  });

  it("records link unfurlers as bots, and counts them nowhere", async () => {
    const res = await load({
      "sec-fetch-dest": "document",
      "user-agent":
        "Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)",
    });
    expect(res.headers.get("set-cookie")).toBeNull();
    await vi.waitFor(async () => expect(await events()).toHaveLength(1));
    expect((await events())[0].uaClass).toBe("bot");
    expect(
      await pg.db.$count(
        appUsageDaily,
        eq(appUsageDaily.appId, objectIdToUuid(APP_ID)),
      ),
    ).toBe(0);
  });
});
