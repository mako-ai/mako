// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { renderHook } from "@testing-library/react";
import { useStableCallback } from "./useStableCallback";

describe("useStableCallback", () => {
  it("keeps one identity across renders and calls the latest closure", () => {
    const { result, rerender } = renderHook(
      ({ n }: { n: number }) => useStableCallback((x: number) => x + n),
      { initialProps: { n: 1 } },
    );
    const first = result.current;
    expect(first(1)).toBe(2);
    rerender({ n: 10 });
    expect(result.current).toBe(first);
    expect(first(1)).toBe(11);
  });
});
