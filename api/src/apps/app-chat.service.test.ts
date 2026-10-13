/**
 * "Chat with app" access: exactly the people who can open the live link, on
 * a published app.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IAppProject } from "../database/workspace-schema";

const resolveProjectRef = vi.fn();
const getMember = vi.fn();
const resolveAppRef = vi.fn();

vi.mock("./worktree.service", () => ({
  resolveProjectRef: (...args: unknown[]) => resolveProjectRef(...args),
  globFiles: vi.fn(),
  readFile: vi.fn(),
}));
vi.mock("../services/workspace.service", () => ({
  workspaceService: { getMember: (...args: unknown[]) => getMember(...args) },
}));
vi.mock("./app-index.service", () => ({
  resolveAppRef: (...args: unknown[]) => resolveAppRef(...args),
}));
vi.mock("./deployment.service", () => ({ artifactStoreForRead: vi.fn() }));
vi.mock("./bindings.service", () => ({
  bindingArtifactKey: vi.fn(),
  readBindingsTolerant: vi.fn(),
}));

const { authorizeAppChat } = await import("./app-chat.service");
const { liveViewerRedirect } = await import("./live-viewer-redirect");

const WS = "64b000000000000000000001";

function app(overrides: Partial<IAppProject> = {}): IAppProject {
  return {
    _id: { toString: () => "64b0000000000000000000aa" },
    workspaceId: { toString: () => WS },
    slug: "sales",
    title: "Sales",
    access: "workspace",
    workspaceRole: "viewer",
    owner_id: "owner",
    sharedWith: [],
    publishedSha: "abc123",
    chatEnabled: true,
    ...overrides,
  } as unknown as IAppProject;
}

describe("authorizeAppChat", () => {
  beforeEach(() => {
    resolveProjectRef.mockReset();
    getMember.mockReset();
    resolveAppRef.mockReset().mockResolvedValue({ title: "Sales report" });
  });

  it("lets a workspace member who can read the app chat with it", async () => {
    resolveProjectRef.mockResolvedValue(app());
    getMember.mockResolvedValue({ role: "viewer" });
    const result = await authorizeAppChat(WS, "sales", "u1");
    expect(result).toMatchObject({ ok: true, title: "Sales report" });
  });

  it("hides a private app from someone it is not shared with", async () => {
    resolveProjectRef.mockResolvedValue(app({ access: "private" }));
    getMember.mockResolvedValue({ role: "member" });
    expect(await authorizeAppChat(WS, "sales", "u1")).toMatchObject({
      ok: false,
      status: 404,
    });
  });

  it("allows a private app's explicit collaborator", async () => {
    resolveProjectRef.mockResolvedValue(
      app({
        access: "private",
        sharedWith: [
          { userId: "u1", role: "viewer", addedAt: new Date() },
        ] as IAppProject["sharedWith"],
      }),
    );
    getMember.mockResolvedValue({ role: "member" });
    expect(await authorizeAppChat(WS, "sales", "u1")).toMatchObject({
      ok: true,
    });
  });

  it("refuses an unpublished app", async () => {
    resolveProjectRef.mockResolvedValue(app({ publishedSha: undefined }));
    getMember.mockResolvedValue({ role: "member" });
    expect(await authorizeAppChat(WS, "sales", "u1")).toMatchObject({
      ok: false,
      status: 400,
    });
  });

  it("is off until the owner turns it on", async () => {
    resolveProjectRef.mockResolvedValue(app({ chatEnabled: undefined }));
    getMember.mockResolvedValue({ role: "member" });
    expect(await authorizeAppChat(WS, "sales", "u1")).toMatchObject({
      ok: false,
      status: 403,
    });
  });

  it("refuses when the app's chat is turned off", async () => {
    resolveProjectRef.mockResolvedValue(app({ chatEnabled: false }));
    getMember.mockResolvedValue({ role: "member" });
    expect(await authorizeAppChat(WS, "sales", "u1")).toMatchObject({
      ok: false,
      status: 403,
      error: "Chat is turned off for this app",
    });
  });

  it("404s an unknown app and 400s a missing id", async () => {
    resolveProjectRef.mockResolvedValue(null);
    expect(await authorizeAppChat(WS, "nope", "u1")).toMatchObject({
      ok: false,
      status: 404,
    });
    expect(await authorizeAppChat(WS, "", "u1")).toMatchObject({
      ok: false,
      status: 400,
    });
  });
});

describe("liveViewerRedirect", () => {
  const base = {
    fetchDest: "document",
    fetchMode: "navigate",
    workspaceId: WS,
    ref: "sales",
    path: `/api/workspaces/${WS}/apps/sales/live/`,
    url: `https://mako.test/api/workspaces/${WS}/apps/sales/live/?rep=Chich`,
  };

  it("sends a browser opening the link to the viewer page, query kept", () => {
    expect(liveViewerRedirect(base)).toBe(`/view/${WS}/sales?rep=Chich`);
    expect(
      liveViewerRedirect({
        ...base,
        path: `/api/workspaces/${WS}/apps/sales/live`,
        url: `https://mako.test/api/workspaces/${WS}/apps/sales/live`,
      }),
    ).toBe(`/view/${WS}/sales`);
  });

  it("serves the bundle's own requests, embeds and API clients", () => {
    expect(
      liveViewerRedirect({
        ...base,
        path: `/api/workspaces/${WS}/apps/sales/live/assets/index.js`,
      }),
    ).toBeNull();
    expect(liveViewerRedirect({ ...base, fetchDest: "iframe" })).toBeNull();
    expect(
      liveViewerRedirect({
        ...base,
        fetchDest: undefined,
        fetchMode: undefined,
      }),
    ).toBeNull();
  });

  it("honours ?raw=1", () => {
    expect(
      liveViewerRedirect({ ...base, url: `${base.url}&raw=1` }),
    ).toBeNull();
  });
});
