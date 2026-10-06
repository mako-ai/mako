/**
 * `/objects` routes (graceful rename): who may rename over REST, and what
 * an old-link lookup answers. The rename services themselves are tested per
 * kind (api/src/rename/**); here the registry is mocked so the route's own
 * rules are pinned:
 *
 *   - POST /{kind}/rename is the signed-in UI's: an API key (which always
 *     carries its creator as `user`) or an MCP OAuth token is refused —
 *     those rename through `rename_object`, where scopes and grants apply;
 *   - the user id reaches the services as a string (a legacy key's user id
 *     is an ObjectId, and the handlers compare ids as strings);
 *   - GET /resolve answers 404 when nothing (the caller may see) answers.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { Types } from "mongoose";

const auth = vi.hoisted(() => ({
  authType: "session" as "session" | "apiKey" | "mcpOAuth",
  user: { id: "u1" } as { id: unknown } | undefined,
}));
vi.mock("../auth/unified-auth.middleware", () => ({
  unifiedAuthMiddleware: async (
    c: { set: (k: string, v: unknown) => void },
    next: () => Promise<void>,
  ) => {
    c.set("authType", auth.authType);
    if (auth.user) c.set("user", auth.user);
    await next();
  },
  isSessionAuth: (c: { get: (k: string) => unknown }) =>
    c.get("authType") === "session",
}));
vi.mock("../services/workspace.service", () => ({
  workspaceService: {
    hasAccess: vi.fn(async () => true),
    getMember: vi.fn(async () => ({ role: "member" })),
  },
}));
const registry = vi.hoisted(() => ({
  renameObject: vi.fn(),
  resolveObjectRef: vi.fn(),
}));
vi.mock("../rename/registry", () => ({
  isRenameKind: (k: string) => ["app", "console", "flow"].includes(k),
  renameObject: registry.renameObject,
  resolveObjectRef: registry.resolveObjectRef,
}));

import { objectRoutes } from "./objects";
import { RenameError } from "../rename/types";

const WS = new Types.ObjectId().toString();
const app = new Hono();
app.route("/api/workspaces/:workspaceId/objects", objectRoutes);

function rename(kind: string, body: unknown): Promise<Response> {
  return Promise.resolve(
    app.request(`/api/workspaces/${WS}/objects/${kind}/rename`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

function resolve(kind: string, ref: string): Promise<Response> {
  const q = new URLSearchParams({ kind, ref });
  return Promise.resolve(
    app.request(`/api/workspaces/${WS}/objects/resolve?${q.toString()}`),
  );
}

beforeEach(() => {
  auth.authType = "session";
  auth.user = { id: "u1" };
  registry.renameObject.mockReset();
  registry.resolveObjectRef.mockReset();
});

describe("POST /objects/{kind}/rename", () => {
  it("renames for a signed-in session, passing the user id as a string", async () => {
    const legacyId = new Types.ObjectId();
    auth.user = { id: legacyId };
    registry.renameObject.mockResolvedValue({ kind: "app", id: "a1" });
    const res = await rename("app", { ref: "a1", title: "New" });
    expect(res.status).toBe(200);
    expect(registry.renameObject).toHaveBeenCalledWith(
      { workspaceId: WS, userId: legacyId.toString(), role: "member" },
      "app",
      { ref: "a1", title: "New" },
    );
  });

  it("refuses an API key even though it carries its creator as user", async () => {
    auth.authType = "apiKey";
    const res = await rename("app", { ref: "a1", title: "New" });
    expect(res.status).toBe(403);
    expect(registry.renameObject).not.toHaveBeenCalled();
  });

  it("refuses an MCP OAuth token (it renames through rename_object)", async () => {
    auth.authType = "mcpOAuth";
    const res = await rename("console", { ref: "c1", slug: "x" });
    expect(res.status).toBe(403);
    expect(registry.renameObject).not.toHaveBeenCalled();
  });

  it("answers a RenameError with its own status and message", async () => {
    registry.renameObject.mockRejectedValue(
      new RenameError("A flow named x already exists", 409),
    );
    const res = await rename("flow", { ref: "f1", slug: "x" });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      success: false,
      error: "A flow named x already exists",
    });
  });
});

describe("GET /objects/resolve", () => {
  it("answers what an old name points at now", async () => {
    const resolved = {
      kind: "app",
      id: "a1",
      via: "alias",
      current: { url: "/apps/traffic-performance" },
    };
    registry.resolveObjectRef.mockResolvedValue(resolved);
    const res = await resolve("app", "seller-media-buying-3");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, resolved });
  });

  it("answers 404 when nothing the caller may see answers to the ref", async () => {
    registry.resolveObjectRef.mockResolvedValue(null);
    const res = await resolve("console", "ghost");
    expect(res.status).toBe(404);
  });
});
