// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { ChatEmptyState } from "./ChatEmptyState";

describe("ChatEmptyState", () => {
  beforeEach(cleanup);

  it("offers the starter prompts and reports which was chosen", () => {
    const onSelect = vi.fn();
    render(
      <ChatEmptyState isMobile={false} disabled={false} onSelect={onSelect} />,
    );
    const first = screen.getByText("What tables are in my database?");
    fireEvent.click(first);
    expect(onSelect).toHaveBeenCalledWith("What tables are in my database?");
    expect(screen.getByText("Ask your data")).toBeTruthy();
  });

  it("disables the prompts when there is no workspace", () => {
    const onSelect = vi.fn();
    render(<ChatEmptyState isMobile={false} disabled onSelect={onSelect} />);
    fireEvent.click(screen.getByText("How many rows are in each table?"));
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("scrolls rather than spilling out of a short pane", () => {
    // Regression: the pane shrinks when an ACP banner or the prompt queue is
    // docked below it (measured as little as ~260px on the preview). With
    // `justify-content: center` the content overflowed symmetrically — the
    // hero bled 22px up into the header and the last suggestion 22px down over
    // the banner. The overlay must scroll, and must centre via the inner
    // block's auto margins so content pins to the top when it stops fitting
    // instead of being pushed out of view in both directions.
    const { container } = render(
      <ChatEmptyState isMobile={false} disabled={false} onSelect={() => {}} />,
    );
    const overlay = container.firstElementChild as HTMLElement;
    const inner = overlay.firstElementChild as HTMLElement;

    expect(getComputedStyle(overlay).overflowY).toBe("auto");
    expect(getComputedStyle(overlay).justifyContent).not.toBe("center");
    expect(getComputedStyle(inner).margin).toBe("auto");
  });

  it("stacks above the virtual list so the prompts are actually clickable", () => {
    // Regression: the overlay and Virtuoso's scroller are positioned siblings
    // in the same container, and the scroller comes LATER in DOM order. With
    // `z-index: auto` it painted on top and swallowed every click, so the
    // intro screen looked correct and did nothing. Caught on the preview by
    // hit-testing a suggestion's centre, which returned Virtuoso's div rather
    // than the button. jsdom cannot hit-test, so pin the declaration instead.
    const { container } = render(
      <ChatEmptyState isMobile={false} disabled={false} onSelect={() => {}} />,
    );
    const overlay = container.firstElementChild as HTMLElement;
    const z = getComputedStyle(overlay).zIndex;
    expect(z).not.toBe("auto");
    expect(Number(z)).toBeGreaterThan(0);
  });
});
