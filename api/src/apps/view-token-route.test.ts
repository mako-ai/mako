/**
 * POST /apps/:id/view-token — the token the in-Mako iframe opens a published
 * app with. An app id with a published, readable row is answered from that
 * row alone (no repo index, no git); every other ref takes the full resolver
 * and keeps its answers.
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
import mongoose, { Types } from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import type { Context, Next } from "hono";

const identity = vi.hoisted(() => ({ userId: "member" }));
vi.mock("../auth/unified-auth.middleware", () => ({
  unifiedAuthMiddleware: async (c: Context, next: Next) => {
    c.set("user", {
      id: identity.userId,
      email: `${identity.userId}@example.com`,
    });
    await next();
  },
}));

// The full resolver reads the repo index (a mirror fetch on prod). Stand in
// for it, and count how often the route reaches for it.
const resolver = vi.hoisted(() => ({
  resolveProjectRef: vi.fn(async (): Promise<unknown> => null),
}));
vi.mock("./worktree.service", async importOriginal => ({
  ...(await importOriginal<typeof import("./worktree.service")>()),
  resolveProjectRef: resolver.resolveProjectRef,
}));

import { createRouter } from "../openapi/core";
import { appsRoutes } from "../routes/apps";
import { User } from "../database/schema";
import {
  AppProject,
  Workspace,
  WorkspaceMember,
  type IAppProject,
} from "../database/workspace-schema";
import { resolvePreviewGrant } from "./preview.service";

const app = createRouter();
app.route("/api/workspaces/:workspaceId/apps", appsRoutes);

const workspaceId = new Types.ObjectId();
const SHA = "38ce8e7b28e8ace0c1d83bdacb95e28df3d5175b";
let mongo: MongoMemoryServer;
let published: IAppProject;

beforeAll(async () => {
  vi.stubEnv("ENCRYPTION_KEY", "ab".repeat(32));
  vi.stubEnv("SESSION_SECRET", "view-token-route-test-secret");
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  await User.create(
    ["member", "app-owner", "outsider"].map(id => ({
      _id: id,
      email: `${id}@example.com`,
    })),
  );
  await Workspace.collection.insertOne({ _id: workspaceId, name: "Tokens" });
});

beforeEach(async () => {
  identity.userId = "member";
  resolver.resolveProjectRef.mockReset();
  resolver.resolveProjectRef.mockResolvedValue(null);
  await AppProject.deleteMany({});
  await WorkspaceMember.deleteMany({});
  await WorkspaceMember.create([
    { workspaceId, userId: "member", role: "member" },
    { workspaceId, userId: "app-owner", role: "member" },
  ]);
  published = await AppProject.create({
    workspaceId,
    title: "Renewals",
    slug: "renewals",
    access: "workspace",
    owner_id: "app-owner",
    createdBy: "app-owner",
    publishedSha: SHA,
  });
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo?.stop();
  vi.unstubAllEnvs();
});

interface TokenBody {
  success: boolean;
  token: string;
  url: string;
  sha: string;
  expiresAt: number;
  appId: string;
  error?: string;
}

async function json(response: Response): Promise<TokenBody> {
  return (await response.json()) as TokenBody;
}

function viewToken(ref: string) {
  return app.request(`/api/workspaces/${workspaceId}/apps/${ref}/view-token`, {
    method: "POST",
  });
}

describe("view token", () => {
  it("answers an app id from its row without the repo resolver", async () => {
    const before = Date.now();
    const response = await viewToken(published._id.toString());
    expect(response.status).toBe(200);
    const body = await json(response);
    expect(resolver.resolveProjectRef).not.toHaveBeenCalled();
    expect(body).toMatchObject({
      success: true,
      sha: SHA,
      appId: published._id.toString(),
    });
    expect(body.url).toBe(`/api/apps-preview/${body.token}/`);
    // Same claims and lifetime as before: workspace, app, sha, viewer, 30 min.
    const grant = resolvePreviewGrant(body.token);
    expect(grant).toMatchObject({
      workspaceId: workspaceId.toString(),
      projectId: published._id.toString(),
      publishedSha: SHA,
      viewer: { id: "member", email: "member@example.com" },
    });
    expect(body.expiresAt).toBeGreaterThanOrEqual(before + 30 * 60 * 1000);
    expect(body.expiresAt).toBeLessThanOrEqual(Date.now() + 30 * 60 * 1000);
  });

  it("leaves a private app the caller cannot read to the full resolver", async () => {
    await AppProject.updateOne({ _id: published._id }, { access: "private" });
    resolver.resolveProjectRef.mockResolvedValue(
      await AppProject.findById(published._id),
    );
    const response = await viewToken(published._id.toString());
    expect(resolver.resolveProjectRef).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(404);
  });

  it("still mints for the private app's owner from the row alone", async () => {
    await AppProject.updateOne({ _id: published._id }, { access: "private" });
    identity.userId = "app-owner";
    const response = await viewToken(published._id.toString());
    expect(response.status).toBe(200);
    expect(resolver.resolveProjectRef).not.toHaveBeenCalled();
  });

  it("sends an unpublished app through the resolver to its usual 404", async () => {
    await AppProject.updateOne(
      { _id: published._id },
      { $unset: { publishedSha: "" } },
    );
    resolver.resolveProjectRef.mockResolvedValue(
      await AppProject.findById(published._id),
    );
    const response = await viewToken(published._id.toString());
    expect(resolver.resolveProjectRef).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(404);
    expect((await json(response)).error).toBe(
      "This app has not been published yet",
    );
  });

  it("resolves a slug through the full resolver and names the app it found", async () => {
    resolver.resolveProjectRef.mockResolvedValue(published);
    const response = await viewToken("renewals");
    expect(resolver.resolveProjectRef).toHaveBeenCalledWith(
      workspaceId.toString(),
      "renewals",
    );
    expect(response.status).toBe(200);
    expect((await json(response)).appId).toBe(published._id.toString());
  });

  it("does not reach another workspace's row by id", async () => {
    const other = await AppProject.create({
      workspaceId: new Types.ObjectId(),
      title: "Elsewhere",
      slug: "elsewhere",
      access: "workspace",
      owner_id: "member",
      createdBy: "member",
      publishedSha: SHA,
    });
    const response = await viewToken(other._id.toString());
    expect(resolver.resolveProjectRef).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(404);
  });
});
