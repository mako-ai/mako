// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatHistoryMenu } from "./ChatHistoryMenu";
import type { ChatSessionMeta } from "./hooks/useChatSessions";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function session(
  overrides: Partial<ChatSessionMeta> & { _id: string },
): ChatSessionMeta {
  return { title: "", ...overrides };
}

function renderMenu(sessions: ChatSessionMeta[]) {
  const onSelect = vi.fn();
  const onDelete = vi.fn();
  render(
    <ChatHistoryMenu
      anchorEl={document.body}
      open
      onClose={() => undefined}
      sessions={sessions}
      currentChatId={sessions[0]?._id ?? ""}
      isSessionStreaming={() => false}
      onSelect={onSelect}
      onDelete={onDelete}
    />,
  );
  return { onSelect, onDelete };
}

/** Local noon today, so day bucketing never straddles a midnight boundary. */
function noonToday(): number {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  return d.getTime();
}

describe("ChatHistoryMenu", () => {
  afterEach(cleanup);

  it("renders a session whose title never generated", () => {
    renderMenu([
      session({ _id: "a", title: "", updatedAt: new Date().toISOString() }),
    ]);

    // The old filter dropped untitled, non-current, non-streaming chats
    // entirely — they became unreachable.
    expect(screen.getByText("New chat")).toBeTruthy();
  });

  it("groups sessions into day buckets, newest first", () => {
    const base = noonToday();
    renderMenu([
      session({
        _id: "today",
        title: "Today chat",
        updatedAt: new Date(base).toISOString(),
      }),
      session({
        _id: "yesterday",
        title: "Yesterday chat",
        updatedAt: new Date(base - DAY).toISOString(),
      }),
      session({
        _id: "week",
        title: "Week chat",
        updatedAt: new Date(base - 3 * DAY).toISOString(),
      }),
      session({
        _id: "older",
        title: "Older chat",
        updatedAt: new Date(base - 90 * DAY).toISOString(),
      }),
      session({ _id: "undated", title: "Undated chat" }),
    ]);

    const rendered = Array.from(
      document.querySelectorAll("li, .MuiListSubheader-root"),
    )
      .map(el => el.textContent ?? "")
      .filter(Boolean);

    const indexOf = (needle: string) =>
      rendered.findIndex(text => text.includes(needle));

    expect(indexOf("Today")).toBeGreaterThanOrEqual(0);
    expect(indexOf("Today")).toBeLessThan(indexOf("Today chat"));
    expect(indexOf("Today chat")).toBeLessThan(indexOf("Yesterday"));
    expect(indexOf("Yesterday chat")).toBeLessThan(indexOf("Previous 7 days"));
    expect(indexOf("Week chat")).toBeLessThan(indexOf("Older"));
    expect(indexOf("Older chat")).toBeLessThan(indexOf("No date"));
    expect(indexOf("Undated chat")).toBeGreaterThan(indexOf("No date"));
  });

  it("filters the list through the search field", () => {
    const now = noonToday();
    const sessions = Array.from({ length: 10 }, (_, i) =>
      session({
        _id: `s${i}`,
        title: i === 3 ? "Warehouse audit" : `Chat number ${i}`,
        updatedAt: new Date(now - i * HOUR).toISOString(),
      }),
    );
    renderMenu(sessions);

    const search = screen.getByLabelText("Search chats");
    fireEvent.change(search, { target: { value: "warehouse" } });

    expect(screen.getByText("Warehouse audit")).toBeTruthy();
    expect(screen.queryByText("Chat number 0")).toBeNull();
  });

  it("shows the cost only when it is non-zero", () => {
    renderMenu([
      session({
        _id: "paid",
        title: "Priced chat",
        updatedAt: new Date().toISOString(),
        usage: { costUsd: 0.0421, totalTokens: 1200 },
      }),
      session({
        _id: "free",
        title: "Free chat",
        updatedAt: new Date().toISOString(),
        usage: { costUsd: 0, totalTokens: 0 },
      }),
    ]);

    expect(screen.getByText("$0.04")).toBeTruthy();
    const freeRow = screen.getByText("Free chat").closest("li");
    expect(freeRow).not.toBeNull();
    expect(within(freeRow as HTMLElement).queryByText(/^\$/)).toBeNull();
  });

  it("names the chat in the delete button's accessible name", () => {
    const { onDelete } = renderMenu([
      session({
        _id: "a",
        title: "Revenue review",
        updatedAt: new Date().toISOString(),
      }),
      session({
        _id: "b",
        title: "Other chat",
        updatedAt: new Date().toISOString(),
      }),
    ]);

    const button = screen.getByRole("button", {
      name: /Delete chat .*Revenue review/,
    });
    fireEvent.click(button);
    expect(onDelete).toHaveBeenCalledWith("a", expect.anything());
  });
});
