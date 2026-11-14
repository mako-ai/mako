import { beforeEach, describe, expect, it, vi } from "vitest";

const GET = vi.fn();
const DELETE = vi.fn();
vi.mock("../api/client", () => ({ api: { GET, DELETE } }));

const { useChatHistoryStore, mergeSessions, CHAT_HISTORY_PAGE_SIZE } =
  await import("./chatHistoryStore");

type Entry = { _id: string; title: string; updatedAt: string };

const at = (minute: number) =>
  new Date(Date.UTC(2026, 0, 1, 0, minute)).toISOString();
const chat = (id: string, minute: number, title = id): Entry => ({
  _id: id.padStart(24, "0"),
  title,
  updatedAt: at(minute),
});
const page = (chats: Entry[], nextCursor: string | null) => ({
  data: { success: true, chats, nextCursor },
  response: { ok: true, status: 200 },
});

/** A promise the test resolves by hand, to interleave requests. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => {
    resolve = r;
  });
  return { promise, resolve };
}

const ids = () =>
  useChatHistoryStore.getState().sessions.map(s => s._id.replace(/^0+/, ""));
const queryOf = (call: number) =>
  GET.mock.calls[call]?.[1]?.params?.query as
    { limit?: number; cursor?: string } | undefined;

describe("chatHistoryStore", () => {
  beforeEach(() => {
    GET.mockReset();
    DELETE.mockReset();
    useChatHistoryStore.getState().reset();
  });

  it("loads the first page, then appends the next on loadMore", async () => {
    GET.mockResolvedValueOnce(page([chat("c", 3), chat("b", 2)], "cur-1"));
    await useChatHistoryStore.getState().refresh("ws");
    expect(queryOf(0)).toEqual({ limit: CHAT_HISTORY_PAGE_SIZE });
    expect(ids()).toEqual(["c", "b"]);
    expect(useChatHistoryStore.getState().nextCursor).toBe("cur-1");

    GET.mockResolvedValueOnce(page([chat("a", 1)], null));
    await useChatHistoryStore.getState().loadMore();
    expect(queryOf(1)).toEqual({
      limit: CHAT_HISTORY_PAGE_SIZE,
      cursor: "cur-1",
    });
    expect(ids()).toEqual(["c", "b", "a"]);
    expect(useChatHistoryStore.getState().nextCursor).toBeNull();

    // At the end: no request.
    await useChatHistoryStore.getState().loadMore();
    expect(GET).toHaveBeenCalledTimes(2);
  });

  it("issues one loadMore at a time", async () => {
    GET.mockResolvedValueOnce(page([chat("b", 2)], "cur-1"));
    await useChatHistoryStore.getState().refresh("ws");
    const pending = deferred<ReturnType<typeof page>>();
    GET.mockReturnValueOnce(pending.promise);
    const first = useChatHistoryStore.getState().loadMore();
    const second = useChatHistoryStore.getState().loadMore();
    expect(GET).toHaveBeenCalledTimes(2);
    pending.resolve(page([chat("a", 1)], null));
    await Promise.all([first, second]);
    expect(ids()).toEqual(["b", "a"]);
  });

  it("refresh folds a new or updated chat in at the top, keeping deeper pages", async () => {
    GET.mockResolvedValueOnce(page([chat("c", 3), chat("b", 2)], "cur-1"));
    await useChatHistoryStore.getState().refresh("ws");
    GET.mockResolvedValueOnce(page([chat("a", 1)], "cur-2"));
    await useChatHistoryStore.getState().loadMore();

    // "a" was just continued (now newest) and "n" is a brand-new chat.
    GET.mockResolvedValueOnce(
      page([chat("n", 9), chat("a", 8, "a renamed"), chat("c", 3)], "cur-x"),
    );
    await useChatHistoryStore.getState().refresh("ws");
    expect(ids()).toEqual(["n", "a", "c", "b"]);
    expect(useChatHistoryStore.getState().sessions[1]?.title).toBe("a renamed");
    // The deeper cursor already reached is kept, not rewound to page 1's.
    expect(useChatHistoryStore.getState().nextCursor).toBe("cur-2");
  });

  it("drops a response for a workspace the list no longer shows", async () => {
    const slowA = deferred<ReturnType<typeof page>>();
    GET.mockReturnValueOnce(slowA.promise);
    const loadA = useChatHistoryStore.getState().refresh("ws-a");

    GET.mockResolvedValueOnce(page([chat("b1", 1)], null));
    await useChatHistoryStore.getState().refresh("ws-b");
    slowA.resolve(page([chat("a1", 5)], "cur-a"));
    await loadA;

    expect(useChatHistoryStore.getState().workspaceId).toBe("ws-b");
    expect(ids()).toEqual(["b1"]);
    expect(useChatHistoryStore.getState().nextCursor).toBeNull();
  });

  it("drops a loadMore page that lands after a workspace switch", async () => {
    GET.mockResolvedValueOnce(page([chat("a2", 2)], "cur-a"));
    await useChatHistoryStore.getState().refresh("ws-a");
    const slowMore = deferred<ReturnType<typeof page>>();
    GET.mockReturnValueOnce(slowMore.promise);
    const more = useChatHistoryStore.getState().loadMore();

    GET.mockResolvedValueOnce(page([chat("b1", 1)], null));
    await useChatHistoryStore.getState().refresh("ws-b");
    slowMore.resolve(page([chat("a1", 1)], null));
    await more;
    expect(ids()).toEqual(["b1"]);
    expect(useChatHistoryStore.getState().loadingMore).toBe(false);
  });

  it("an older refresh never overwrites a newer one", async () => {
    const slow = deferred<ReturnType<typeof page>>();
    GET.mockReturnValueOnce(slow.promise);
    const older = useChatHistoryStore.getState().refresh("ws");
    GET.mockResolvedValueOnce(page([chat("new", 9)], null));
    await useChatHistoryStore.getState().refresh("ws");
    slow.resolve(page([chat("stale", 1)], "cur-stale"));
    await older;
    expect(ids()).toEqual(["new"]);
    expect(useChatHistoryStore.getState().nextCursor).toBeNull();
  });

  it("keeps the list when a page fails", async () => {
    GET.mockResolvedValueOnce(page([chat("b", 2)], "cur-1"));
    await useChatHistoryStore.getState().refresh("ws");
    GET.mockResolvedValueOnce({
      data: undefined,
      response: { ok: false, status: 400 },
    });
    await useChatHistoryStore.getState().loadMore();
    expect(ids()).toEqual(["b"]);
    expect(useChatHistoryStore.getState().nextCursor).toBe("cur-1");
    expect(useChatHistoryStore.getState().loadingMore).toBe(false);
  });

  it("removes a deleted chat", async () => {
    GET.mockResolvedValueOnce(page([chat("b", 2), chat("a", 1)], null));
    await useChatHistoryStore.getState().refresh("ws");
    DELETE.mockResolvedValueOnce({ response: { ok: true, status: 200 } });
    const ok = await useChatHistoryStore
      .getState()
      .deleteSession("ws", "b".padStart(24, "0"));
    expect(ok).toBe(true);
    expect(ids()).toEqual(["a"]);
  });

  it("orders ties on updatedAt by _id desc, like the server", () => {
    const merged = mergeSessions(
      [chat("a", 1), chat("c", 1)],
      [chat("b", 1), chat("c", 1, "fresh")],
    );
    expect(merged.map(s => s._id.replace(/^0+/, ""))).toEqual(["c", "b", "a"]);
    expect(merged[0]?.title).toBe("fresh");
  });
});
