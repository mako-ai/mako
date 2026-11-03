// @vitest-environment jsdom
/**
 * useChatSessionLoader — restoring a chat's consoles.
 *
 * The chat the panel shows when the page loads is restored asynchronously,
 * after a deep link (/n/:id, /f/:id) or the persisted active tab has chosen
 * what the editor shows. It must reopen its consoles without taking focus;
 * a chat picked from history afterwards still brings its console forward.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";

const consoleState = vi.hoisted(() => ({
  tabs: {} as Record<string, unknown>,
  activeTabId: null as string | null,
  setActiveTab: vi.fn(),
  openConsoleFromServer: vi.fn(),
}));

vi.mock("../../../store/consoleStore", () => ({
  useConsoleStore: { getState: () => consoleState },
}));

vi.mock("../../../api/client", () => ({
  api: {
    GET: vi.fn(
      async (_url: string, opts: { params: { path: { id: string } } }) => ({
        data: {
          messages: [],
          consoles: [{ id: `${opts.params.path.id}-console` }],
        },
        response: { ok: true },
      }),
    ),
  },
}));

// The page-load chat lives at module scope, so each test imports a fresh copy.
let useChatSessionLoader: typeof import("./useChatSessionLoader").useChatSessionLoader;

function render(chatId: string, workspaceId: string | null = "ws") {
  const ref = <T>(current: T) => ({ current });
  const args = {
    chatId,
    isExistingChat: true,
    setMessages: vi.fn(),
    messagesRef: ref([]),
    workspaceIdRef: ref<string | undefined>(workspaceId ?? undefined),
    chatIdRef: ref(chatId),
    virtuosoRef: ref(null),
    capturedConsoleIdRef: ref<string | null>(null),
    handledConsoleOpenToolCallIdsRef: ref(new Set<string>()),
    toolDispatchGateRef: ref({ seedFromPersistedMessages: vi.fn() }),
    loadPersistedMessagesRef: ref(undefined),
    requestResumeRef: ref(vi.fn(async () => {})),
    localAcpBindingRef: ref(null),
    localAcpBusyRef: ref(false),
  };
  type Props = { id: string; ws?: string | null };
  const hook = renderHook<void, Props>(
    ({ id, ws = "ws" }) => {
      args.chatIdRef.current = id;
      args.workspaceIdRef.current = ws ?? undefined;
      useChatSessionLoader({
        ...(args as unknown as Parameters<typeof useChatSessionLoader>[0]),
        chatId: id,
        workspaceId: ws ?? undefined,
      });
    },
    { initialProps: { id: chatId, ws: workspaceId } },
  );
  return { ...hook, args };
}

describe("useChatSessionLoader console restore", () => {
  beforeEach(async () => {
    consoleState.tabs = {};
    consoleState.setActiveTab.mockClear();
    consoleState.openConsoleFromServer.mockClear();
    consoleState.openConsoleFromServer.mockImplementation(
      async (_workspaceId: string, consoleId: string) => {
        consoleState.tabs[consoleId] = {};
      },
    );
    vi.resetModules();
    ({ useChatSessionLoader } = await import("./useChatSessionLoader"));
  });

  it("reopens the page-load chat's console without focusing it, then focuses for a chat picked later", async () => {
    const { rerender, args } = render("restored-chat");

    await waitFor(() =>
      expect(args.capturedConsoleIdRef.current).toBe("restored-chat-console"),
    );
    expect(consoleState.openConsoleFromServer).toHaveBeenCalledWith(
      "ws",
      "restored-chat-console",
      { focus: false },
    );
    expect(consoleState.setActiveTab).not.toHaveBeenCalled();

    rerender({ id: "picked-chat" });
    await waitFor(() =>
      expect(consoleState.setActiveTab).toHaveBeenCalledWith(
        "picked-chat-console",
      ),
    );
    expect(consoleState.openConsoleFromServer).toHaveBeenLastCalledWith(
      "ws",
      "picked-chat-console",
      { focus: true },
    );
  });

  it("brings the page-load chat's console forward when the user returns to it", async () => {
    const { rerender, args } = render("chat-a");
    await waitFor(() =>
      expect(args.capturedConsoleIdRef.current).toBe("chat-a-console"),
    );
    expect(consoleState.setActiveTab).not.toHaveBeenCalled();

    rerender({ id: "chat-b" });
    await waitFor(() =>
      expect(consoleState.setActiveTab).toHaveBeenLastCalledWith(
        "chat-b-console",
      ),
    );

    rerender({ id: "chat-a" });
    await waitFor(() =>
      expect(consoleState.setActiveTab).toHaveBeenLastCalledWith(
        "chat-a-console",
      ),
    );
  });

  it("keeps the page-load chat unfocused when the workspace resolves after mount", async () => {
    const { rerender, args } = render("chat-a", null);
    expect(consoleState.openConsoleFromServer).not.toHaveBeenCalled();

    rerender({ id: "chat-a", ws: "ws" });
    await waitFor(() =>
      expect(args.capturedConsoleIdRef.current).toBe("chat-a-console"),
    );
    expect(consoleState.openConsoleFromServer).toHaveBeenCalledWith(
      "ws",
      "chat-a-console",
      { focus: false },
    );
    expect(consoleState.setActiveTab).not.toHaveBeenCalled();
  });
});
