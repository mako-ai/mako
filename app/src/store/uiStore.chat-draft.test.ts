// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { useUIStore } from "./uiStore";

/**
 * "Ask Mako to fix" hands the chat a first message through the store: it
 * opens the chat (the right pane, or Ask on a phone) and is never persisted.
 */
describe("uiStore chat draft", () => {
  beforeEach(() => {
    useUIStore.getState().reset();
  });

  it("opens the chat with the draft", () => {
    const s = useUIStore.getState();
    s.closeRightPane();
    s.setMobileTab("view");
    s.askMako("The workflow failed.");
    const after = useUIStore.getState();
    expect(after.chatDraft?.text).toBe("The workflow failed.");
    expect(after.rightPaneOpen).toBe(true);
    expect(after.mobileTab).toBe("ask");
  });

  it("tells two drafts with the same text apart, and clears", () => {
    const s = useUIStore.getState();
    s.askMako("again");
    const first = useUIStore.getState().chatDraft;
    s.askMako("again");
    expect(useUIStore.getState().chatDraft).not.toBe(first);
    s.clearChatDraft();
    expect(useUIStore.getState().chatDraft).toBeNull();
  });

  it("does not persist the draft", () => {
    useUIStore.getState().askMako("not kept");
    const stored = localStorage.getItem("ui-store") ?? "";
    expect(stored).not.toContain("not kept");
  });
});
