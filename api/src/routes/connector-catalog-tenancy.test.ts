/**
 * The public connector catalog must not answer for a workspace on the
 * caller's say-so.
 *
 * `GET /api/connectors/types` and `/{type}/schema` are deliberately
 * unauthenticated — the built-in catalog is the same for everyone. Workspace
 * connectors were then appended purely on the `x-workspace-id` HEADER, which
 * is whatever the caller typed: `curl -H 'x-workspace-id: <any id>'` returned
 * that tenant's connector slugs, entity names and `blockedReason` (their own
 * stderr), and the schema route returned their credential field names.
 *
 * BEFORE/AFTER PROOF: on the old handler the "not a member" cases below
 * answered 200 with the workspace's connectors, so they fail before this
 * change and pass after it. The member case is the forward pin that keeps the
 * fix from being made by simply deleting the feature.
 *
 * Real routes + real Mongo; only auth and the workspace service are mocked,
 * because who the caller is is exactly what those two decide.
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
import mongoose, { Types } from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

const ctx = vi.hoisted(() => ({
  signedIn: true,
  memberOf: [] as string[],
}));

vi.mock("../auth/unified-auth.middleware", () => ({
  unifiedAuthMiddleware: async (
    c: {
      set: (k: string, v: unknown) => void;
      json: (b: unknown, s: number) => unknown;
    },
    next: () => Promise<void>,
  ) => {
    if (!ctx.signedIn) return c.json({ error: "Unauthorized" }, 401);
    c.set("user", { id: "u1" });
    await next();
  },
}));

vi.mock("../services/workspace.service", () => ({
  workspaceService: {
    hasAccess: vi.fn(async (workspaceId: string) =>
      ctx.memberOf.includes(workspaceId),
    ),
  },
}));

import { connectorRoutes } from "./connectors";
import { ConnectorDefinition } from "../database/workspace-schema";

let mongo: MongoMemoryServer;
const WS_THEIRS = new Types.ObjectId().toString();

const app = new Hono();
app.route("/api/connectors", connectorRoutes);

const get = (path: string, workspaceId?: string): Promise<Response> =>
  Promise.resolve(
    app.request(
      `/api/connectors${path}`,
      workspaceId ? { headers: { "x-workspace-id": workspaceId } } : undefined,
    ),
  );

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

beforeEach(async () => {
  ctx.signedIn = true;
  ctx.memberOf = [];
  await ConnectorDefinition.deleteMany({});
  await ConnectorDefinition.create({
    workspaceId: new Types.ObjectId(WS_THEIRS),
    slug: "acme-crm",
    runtime: "node",
    entry: "connector.ts",
    sha: "0".repeat(40),
    sourceSha: "0".repeat(40),
    status: "indexed",
    entities: ["deals"],
    spec: {
      connectionSpecification: {
        properties: {
          apiKey: { type: "string", title: "API key", airbyte_secret: true },
        },
      },
      mako: { name: "acme-crm", version: "1.0.0" },
    },
  });
});

const bodyOf = async (response: Response): Promise<any> => response.json();

describe("GET /api/connectors/types", () => {
  it("does not list a workspace's connectors for an anonymous caller", async () => {
    ctx.signedIn = false;
    const response = await get("/types", WS_THEIRS);
    expect(response.status).toBe(200);
    const body = await bodyOf(response);
    expect(
      body.data.some((entry: { type: string }) => entry.type === "ws:acme-crm"),
    ).toBe(false);
  });

  it("does not list them for someone signed in to another workspace", async () => {
    ctx.memberOf = [new Types.ObjectId().toString()];
    const body = await bodyOf(await get("/types", WS_THEIRS));
    expect(
      body.data.some((entry: { type: string }) => entry.type === "ws:acme-crm"),
    ).toBe(false);
    // The built-in catalog is still public: the route did not become 401.
    expect(body.data.length).toBeGreaterThan(0);
  });

  it("lists them for a member", async () => {
    ctx.memberOf = [WS_THEIRS];
    const body = await bodyOf(await get("/types", WS_THEIRS));
    expect(
      body.data.find((entry: { type: string }) => entry.type === "ws:acme-crm"),
    ).toMatchObject({ name: "acme-crm", supportedEntities: ["deals"] });
  });
});

describe("GET /api/connectors/{type}/schema", () => {
  it("does not reveal a workspace connector's credential fields to a non-member", async () => {
    ctx.memberOf = [];
    const response = await get("/ws:acme-crm/schema", WS_THEIRS);
    expect(response.status).toBe(404);
    // The same answer a type that does not exist gets: the route cannot be
    // used to probe which workspace owns a connector of a given name.
    expect((await bodyOf(response)).error).toBe("Connector not found");
  });

  it("returns the form for a member", async () => {
    ctx.memberOf = [WS_THEIRS];
    const response = await get("/ws:acme-crm/schema", WS_THEIRS);
    expect(response.status).toBe(200);
    const body = await bodyOf(response);
    expect(body.data.fields).toEqual([
      {
        name: "apiKey",
        label: "API key",
        type: "password",
        required: false,
        encrypted: true,
      },
    ]);
  });
});
