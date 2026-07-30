// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppErrorBoundary } from "./AppErrorBoundary";

function BrokenChild(): React.ReactNode {
  throw new Error("tool card exploded");
}

describe("AppErrorBoundary", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("shows a recoverable screen when the React root throws", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    render(
      <AppErrorBoundary>
        <BrokenChild />
      </AppErrorBoundary>,
    );

    expect(screen.getByRole("alert").textContent).toContain(
      "Mako hit a display error",
    );
    expect(screen.getByText("tool card exploded")).toBeTruthy();
  });

  it("reloads on request", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const onReload = vi.fn();

    render(
      <AppErrorBoundary onReload={onReload}>
        <BrokenChild />
      </AppErrorBoundary>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Reload Mako" }));

    expect(onReload).toHaveBeenCalledOnce();
  });
});
