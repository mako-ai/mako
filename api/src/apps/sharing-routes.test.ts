import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import mongoose, { Types } from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import type { Context, Next } from "hono";

// Supply an authenticated identity; keep membership, ACLs, persistence and
// the mounted sharing routes real so a missing role cannot pass unnoticed.
const identity = vi.hoisted(() => ({ userId: "admin" }));
vi.mock("../auth/unified-auth.middleware", () => ({
  unifiedAuthMiddleware: async (c: Context, next: Next) => {
    c.set("user", {
      id: identity.userId,
      email: `${identity.userId}@example.com`,
    });
    await next();
  },
}));

import { createRouter } from "../openapi/core";
import { appsRoutes } from "../routes/apps";
import { publicShareRoutes, recordSharedAppOpen } from "../routes/public-share";
import { anonIdFromCookie, resetUsageThrottle } from "./app-usage.service";
import { User } from "../database/schema";
import {
  AppProject,
  AppUsageDaily,
  AppUsageEvent,
  Workspace,
  WorkspaceMember,
  type IAppProject,
} from "../database/workspace-schema";

const app = createRouter();
app.route("/api/workspaces/:workspaceId/apps", appsRoutes);
app.route("/api/share", publicShareRoutes);

const workspaceId = new Types.ObjectId();
let mongo: MongoMemoryServer;
let project: IAppProject;

beforeAll(async () => {
  vi.stubEnv("ENCRYPTION_KEY", "ab".repeat(32));
  vi.stubEnv("SESSION_SECRET", "sharing-route-test-secret");
  vi.stubEnv("BCRYPT_ROUNDS", "4");
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  await User.create(
    ["admin", "owner", "member", "viewer", "app-owner", "newcomer"].map(id => ({
      _id: id,
      email: `${id}@example.com`,
    })),
  );
  await Workspace.collection.insertOne({
    _id: workspaceId,
    name: "Sharing test",
  });
});

beforeEach(async () => {
  identity.userId = "admin";
  await AppProject.deleteMany({});
  await WorkspaceMember.deleteMany({});
  await Workspace.updateOne({ _id: workspaceId }, { $unset: { settings: "" } });
  await WorkspaceMember.create([
    { workspaceId, userId: "admin", role: "admin" },
    { workspaceId, userId: "owner", role: "owner" },
    { workspaceId, userId: "member", role: "member" },
    { workspaceId, userId: "viewer", role: "viewer" },
  ]);
  project = await AppProject.create({
    workspaceId,
    title: "Financial Model",
    slug: "financial-model",
    access: "workspace",
    owner_id: "app-owner",
    createdBy: "app-owner",
  });
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo?.stop();
  vi.unstubAllEnvs();
});

function manage(suffix: string, method: string, body?: object) {
  return app.request(
    `/api/workspaces/${workspaceId}/apps/${project._id}/${suffix}`,
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
      const { data } = await response.json();
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
      expect((await content.json()).data).toMatchObject({
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
          userId: "viewer",
          role: "viewer",
        })
      ).status,
    ).toBe(200);
    const saved = await AppProject.findById(project._id);
    expect(saved?.workspaceRole).toBe("editor");
    expect(saved?.sharedWith?.map(entry => entry.userId)).toContain("viewer");
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
        (await AppProject.findById(project._id))?.publicShare?.enabled,
      ).not.toBe(true);
    },
  );

  it("does not let admins share another person's private app", async () => {
    project.access = "private";
    await project.save();
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
    await Workspace.updateOne(
      { _id: workspaceId },
      {
        $set: {
          "settings.autoJoin": { domains: ["example.com"], role: "viewer" },
        },
      },
    );
    expect((await manage("collaborators", "GET")).status).toBe(200);
    expect(
      (await WorkspaceMember.findOne({ workspaceId, userId: "newcomer" }))
        ?.role,
    ).toBe("viewer");
    expect(
      (await manage("public-share", "POST", { password: "test-password" }))
        .status,
    ).toBe(403);
  });
});

describe("anonymous share viewers (usage)", () => {
  // The share route's open recording, on a stand-in for the served entry:
  // the real one needs a built deployment in the artifact store.
  const APP_ID = new Types.ObjectId().toString();
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
    AppUsageEvent.find({ appId: APP_ID }).sort({ at: 1 }).lean();

  beforeEach(async () => {
    resetUsageThrottle();
    await AppUsageEvent.deleteMany({});
    await AppUsageDaily.deleteMany({});
  });

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
    expect(await AppUsageDaily.countDocuments({ appId: APP_ID })).toBe(0);
  });
});
