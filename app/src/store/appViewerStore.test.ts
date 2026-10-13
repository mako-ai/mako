import { beforeEach, describe, expect, it, vi } from "vitest";

const GET = vi.fn();
const POST = vi.fn();
vi.mock("../api/client", () => ({ api: { GET, POST } }));

const { appViewerKey, useAppViewerStore } = await import("./appViewerStore");

const ok = (data: unknown) => ({ data, response: { ok: true, status: 200 } });
const fail = (status: number) => ({
  data: undefined,
  error: { error: "nope" },
  response: { ok: false, status },
});

const KEY = appViewerKey("ws", "sales");

describe("appViewerStore.openViewer", () => {
  beforeEach(() => {
    GET.mockReset();
    POST.mockReset();
    useAppViewerStore.setState({ viewerByApp: {}, chatsByApp: {} });
  });

  it("holds the published app's title and view URL", async () => {
    GET.mockResolvedValue(ok({ app: { title: "Sales", chatEnabled: true } }));
    POST.mockResolvedValue(ok({ url: "/api/apps-preview/tok/" }));
    await useAppViewerStore.getState().openViewer("ws", "sales");
    expect(useAppViewerStore.getState().viewerByApp[KEY]).toEqual({
      status: "ready",
      title: "Sales",
      viewUrl: "/api/apps-preview/tok/",
      chatEnabled: true,
    });
  });

  it("reports chat as off unless the owner turned it on", async () => {
    GET.mockResolvedValue(ok({ app: { title: "Sales" } }));
    POST.mockResolvedValue(ok({ url: "/api/apps-preview/tok/" }));
    await useAppViewerStore.getState().openViewer("ws", "sales");
    expect(useAppViewerStore.getState().viewerByApp[KEY]?.chatEnabled).toBe(
      false,
    );
  });

  it("says the app is unpublished when only the token is refused", async () => {
    GET.mockResolvedValue(ok({ app: { title: "Sales" } }));
    POST.mockResolvedValue(fail(404));
    await useAppViewerStore.getState().openViewer("ws", "sales");
    expect(useAppViewerStore.getState().viewerByApp[KEY]?.error).toMatch(
      /not been published/,
    );
  });

  it("does not reveal whether an inaccessible app exists", async () => {
    GET.mockResolvedValue(fail(404));
    POST.mockResolvedValue(fail(404));
    await useAppViewerStore.getState().openViewer("ws", "sales");
    expect(useAppViewerStore.getState().viewerByApp[KEY]?.error).toMatch(
      /doesn't exist or you don't have access/,
    );
  });
});

describe("appViewerStore.fetchChats", () => {
  it("stores the viewer's chats with the app", async () => {
    GET.mockResolvedValue(
      ok({ chats: [{ id: "c1", title: "Revenue", updatedAt: "2026-10-13" }] }),
    );
    await useAppViewerStore.getState().fetchChats("ws", "sales");
    expect(useAppViewerStore.getState().chatsByApp[KEY]).toEqual([
      { id: "c1", title: "Revenue", updatedAt: "2026-10-13" },
    ]);
    expect(GET).toHaveBeenCalledWith(
      "/api/workspaces/{workspaceId}/apps/{id}/chats",
      { params: { path: { workspaceId: "ws", id: "sales" } } },
    );
  });
});
