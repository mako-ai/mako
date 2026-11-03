// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { ChatInputArea } from "./ChatInputArea";

// These controls load workspace/model data. The composer itself stays real.
vi.mock("../../contexts/workspace-context", () => ({
  useOptionalWorkspace: () => null,
}));
vi.mock("../ModelSelector", () => ({
  ModelSelector: () => <span>Model selector</span>,
}));
vi.mock("./SessionUsageBadge", () => ({
  SessionUsageBadge: () => <span>Session usage</span>,
}));

afterEach(cleanup);

function composer(overrides = {}) {
  const props = {
    onSubmit: vi.fn(),
    onStop: vi.fn(),
    isLoading: false,
    disabled: false,
    focusKey: "chat-1",
    paletteMode: "light" as const,
    editingPrompt: null,
    onCancelEdit: vi.fn(),
    chatId: "chat-1",
    ...overrides,
  };
  render(<ChatInputArea {...props} />);
  const input = screen.getByRole("textbox");
  fireEvent.change(input, { target: { value: "Show my tables" } });
  return { input, ...props };
}

describe("chat composer interactions", () => {
  it("supports the published app composer without a workspace or model controls", () => {
    const { input } = composer({
      placeholder: "Ask about this app...",
      allowAttachments: false,
      showModelControls: false,
    });
    expect(input.getAttribute("placeholder")).toBe("Ask about this app...");
    expect(screen.queryByRole("button", { name: "Attach image" })).toBeNull();
    expect(screen.queryByText("Model selector")).toBeNull();
    expect(screen.queryByText("Session usage")).toBeNull();
    fireEvent.paste(input, {
      clipboardData: {
        items: [{ kind: "file", type: "image/png", getAsFile: vi.fn() }],
      },
    });
    expect(screen.queryByRole("button", { name: /^Preview / })).toBeNull();
  });

  it("does not send Enter while an IME composition is active", () => {
    const { input, onSubmit } = composer();
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("does not bypass the disabled send control with Enter", () => {
    const { input, onSubmit } = composer({ disabled: true });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("preserves the draft when streaming submissions are disabled and still allows Stop", () => {
    const { input, onSubmit, onStop } = composer({
      disabled: true,
      isLoading: true,
    });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "Queue message" }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect((input as HTMLTextAreaElement).value).toBe("Show my tables");
    fireEvent.click(screen.getByRole("button", { name: "Stop generating" }));
    expect(onStop).toHaveBeenCalledOnce();
  });

  it("keeps Shift+Enter for a newline and submits Enter once", async () => {
    const { input, onSubmit } = composer();
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(onSubmit).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
    expect(onSubmit).toHaveBeenCalledWith("Show my tables", undefined);
  });

  it("can queue with Enter while Stop still cancels the active reply", async () => {
    const { input, onSubmit, onStop } = composer({ isLoading: true });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("button", { name: "Stop generating" }));
    expect(onStop).toHaveBeenCalledOnce();
  });
});
