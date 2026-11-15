// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Notifier } from "./Notifier";
import { notify, useNotificationStore } from "../store/notificationStore";

describe("Notifier", () => {
  beforeEach(() => {
    useNotificationStore.setState({ queue: [] });
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("renders a severity toast as an Alert with a close button", () => {
    render(<Notifier />);
    act(() => {
      notify.error("Could not delete that chat.");
    });
    expect(screen.getByRole("alert").textContent).toContain(
      "Could not delete that chat.",
    );
    expect(screen.getByRole("button", { name: /close/i })).toBeTruthy();
  });

  it("renders a plain message without an Alert", () => {
    render(<Notifier />);
    act(() => {
      notify.message("Copied to clipboard");
    });
    expect(screen.getByText("Copied to clipboard")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /close/i })).toBeNull();
  });

  it("runs an action and closes the toast", () => {
    const onClick = vi.fn();
    render(<Notifier />);
    act(() => {
      notify.info("A new version is available.", {
        autoHideDuration: null,
        action: { label: "Reload", onClick },
      });
    });
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("auto-hides and then removes the toast from the queue", () => {
    vi.useFakeTimers();
    render(<Notifier />);
    act(() => {
      notify.success("Saved", { autoHideDuration: 1000 });
    });
    expect(screen.getByText("Saved")).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    // Exit transition, then onExited removes it.
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(useNotificationStore.getState().queue).toHaveLength(0);
    expect(screen.queryByText("Saved")).toBeNull();
  });

  it("a newer toast replaces the visible one", () => {
    vi.useFakeTimers();
    render(<Notifier />);
    act(() => {
      notify.info("Preparing CSV…");
    });
    act(() => {
      notify.success("CSV downloaded");
    });
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.queryByText("Preparing CSV…")).toBeNull();
    expect(screen.getByText("CSV downloaded")).toBeTruthy();
  });

  it("dismiss closes the visible toast", () => {
    vi.useFakeTimers();
    render(<Notifier />);
    let id = 0;
    act(() => {
      id = notify.info("Preparing…", { autoHideDuration: null });
    });
    act(() => {
      notify.dismiss(id);
    });
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.queryByText("Preparing…")).toBeNull();
    expect(useNotificationStore.getState().queue).toHaveLength(0);
  });
});
