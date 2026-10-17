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
    GET: vi.fn(async () => ({
      data: { messages: [], consoles: [{ id: "chat-console" }] },
      response: { ok: true },
    })),
  },
}));

import { useChatSessionLoader } from "./useChatSessionLoader";

function render(chatId: string) {
  const ref = <T>(current: T) => ({ current });
  const args = {
    chatId,
    isExistingChat: true,
    workspaceId: "ws",
    setMessages: vi.fn(),
    messagesRef: ref([]),
    workspaceIdRef: ref<string | undefined>("ws"),
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
  const hook = renderHook(
    ({ id }: { id: string }) => {
      args.chatIdRef.current = id;
      useChatSessionLoader({
        ...(args as unknown as Parameters<typeof useChatSessionLoader>[0]),
        chatId: id,
      });
    },
    { initialProps: { id: chatId } },
  );
  return { ...hook, args };
}

describe("useChatSessionLoader console restore", () => {
  beforeEach(() => {
    consoleState.setActiveTab.mockClear();
    consoleState.openConsoleFromServer.mockClear();
  });

  it("reopens the page-load chat's console without focusing it, then focuses for a chat picked later", async () => {
    const { rerender, args } = render("restored-chat");

    await waitFor(() =>
      expect(args.capturedConsoleIdRef.current).toBe("chat-console"),
    );
    expect(consoleState.openConsoleFromServer).toHaveBeenCalledWith(
      "ws",
      "chat-console",
      { focus: false },
    );
    expect(consoleState.setActiveTab).not.toHaveBeenCalled();

    rerender({ id: "picked-chat" });
    await waitFor(() =>
      expect(consoleState.setActiveTab).toHaveBeenCalledWith("chat-console"),
    );
    expect(consoleState.openConsoleFromServer).toHaveBeenLastCalledWith(
      "ws",
      "chat-console",
      { focus: true },
    );
  });
});
