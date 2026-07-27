// @vitest-environment jsdom
import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatMessageErrorBoundary } from "./ChatMessageErrorBoundary";

function BrokenMessage(): React.ReactNode {
  throw new Error("invalid tool payload");
}

describe("ChatMessageErrorBoundary", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("isolates a broken message from its siblings", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    render(
      <>
        <div>Earlier message remains visible</div>
        <ChatMessageErrorBoundary
          messageId="message-1"
          messageRevision="revision-1"
        >
          <BrokenMessage />
        </ChatMessageErrorBoundary>
      </>,
    );

    expect(screen.getByText("Earlier message remains visible")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain(
      "The rest of the chat is still running",
    );
  });

  it("resets when the virtualized row receives another message", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const view = render(
      <ChatMessageErrorBoundary
        messageId="message-1"
        messageRevision="revision-1"
      >
        <BrokenMessage />
      </ChatMessageErrorBoundary>,
    );

    view.rerender(
      <ChatMessageErrorBoundary
        messageId="message-2"
        messageRevision="revision-1"
      >
        <div>Replacement message</div>
      </ChatMessageErrorBoundary>,
    );

    expect(screen.getByText("Replacement message")).toBeTruthy();
  });

  it("retries a streamed message when its content advances", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const view = render(
      <ChatMessageErrorBoundary
        messageId="message-1"
        messageRevision="revision-1"
      >
        <BrokenMessage />
      </ChatMessageErrorBoundary>,
    );

    view.rerender(
      <ChatMessageErrorBoundary
        messageId="message-1"
        messageRevision="revision-2"
      >
        <div>Completed tool result</div>
      </ChatMessageErrorBoundary>,
    );

    expect(screen.getByText("Completed tool result")).toBeTruthy();
  });
});
