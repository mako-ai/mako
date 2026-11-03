// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ReasoningDisplay } from "./ReasoningDisplay";

afterEach(cleanup);

describe("reasoning trace", () => {
  it("does not offer an empty disclosure before reasoning arrives", () => {
    render(
      <ReasoningDisplay reasoningText="" isStreaming paletteMode="light" />,
    );
    expect(screen.getByText("Thinking")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("collapses at completion and lets the reader open the reasoning again", () => {
    const { rerender } = render(
      <ReasoningDisplay
        reasoningText="Check the table schema."
        isStreaming
        paletteMode="light"
      />,
    );
    expect(screen.getByRole("button").getAttribute("aria-expanded")).toBe(
      "true",
    );
    rerender(
      <ReasoningDisplay
        reasoningText="Check the table schema."
        isStreaming={false}
        paletteMode="light"
      />,
    );
    expect(screen.getByRole("button").getAttribute("aria-expanded")).toBe(
      "false",
    );
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByRole("button").getAttribute("aria-expanded")).toBe(
      "true",
    );
  });
});
