// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { StreamingToolCard } from "./StreamingToolCard";

afterEach(cleanup);

describe("tool trace interactions", () => {
  it("unmounts output when the reader collapses the tool", async () => {
    render(
      <StreamingToolCard
        toolName="inspect_data"
        state="output-available"
        output="The complete tool result"
      />,
    );
    const trigger = screen.getByRole("button");
    expect(screen.queryByText("The complete tool result")).toBeNull();
    fireEvent.click(trigger);
    expect(screen.getByText("The complete tool result")).toBeTruthy();
    fireEvent.click(trigger);
    await waitFor(() =>
      expect(screen.queryByText("The complete tool result")).toBeNull(),
    );
  });

  it("opens the console without toggling tool output", () => {
    const onTitleClick = vi.fn();
    render(
      <StreamingToolCard
        toolName="inspect_data"
        labelOverride="Customer query"
        state="output-available"
        output="Private result"
        onTitleClick={onTitleClick}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Open Customer query" }),
    );
    expect(onTitleClick).toHaveBeenCalledOnce();
    expect(screen.queryByText("Private result")).toBeNull();
  });
});
