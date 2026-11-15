// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { MutableRefObject } from "react";
import type { ConsoleTab } from "../../../store/lib/types";
import type { ChartSpecChangePayload, ConsoleResultsContext } from "../types";
import type { MakoChartSpec } from "../../../lib/chart-spec";

const updateChartSpec = vi.fn();
const updateResultsViewMode = vi.fn();
vi.mock("../../../store/consoleStore", () => ({
  useConsoleStore: (selector: (s: object) => unknown) =>
    selector({ updateChartSpec, updateResultsViewMode }),
}));

import { useResultsViewState } from "./useResultsViewState";

const spec = { mark: "bar" } as unknown as MakoChartSpec;

describe("useResultsViewState", () => {
  it("seeds from persisted tabs and bridges Chat's chart + results refs", () => {
    const tab = {
      id: "t1",
      resultsViewMode: "json",
    } as unknown as ConsoleTab;
    const chartRef: MutableRefObject<
      ((p: ChartSpecChangePayload) => void) | undefined
    > = { current: undefined };
    const contextRef: MutableRefObject<ConsoleResultsContext | null> = {
      current: null,
    };
    const { result } = renderHook(() =>
      useResultsViewState({
        tabs: { t1: tab },
        consoleTabs: [tab],
        activeTabId: "t1",
        tabResults: {
          t1: {
            results: [{ a: 1 }],
            executedAt: "x",
            resultCount: 1,
          },
        },
        onChartSpecChangeRef: chartRef,
        resultsContextRef: contextRef,
      }),
    );

    expect(result.current.tabViewModes.t1).toBe("json");
    expect(contextRef.current).toMatchObject({
      viewMode: "json",
      hasResults: true,
      columns: ["a"],
    });

    const onRenderResult = vi.fn();
    act(() => chartRef.current?.({ spec, onRenderResult }));
    expect(result.current.tabChartSpecs.t1).toBe(spec);
    expect(result.current.tabViewModes.t1).toBe("chart");
    expect(updateChartSpec).toHaveBeenCalledWith("t1", spec);
    expect(updateResultsViewMode).toHaveBeenCalledWith("t1", "chart");

    // The pending render callback resolves exactly once.
    act(() => result.current.reportChartRender("t1", { success: true }));
    act(() => result.current.reportChartRender("t1", { success: false }));
    expect(onRenderResult).toHaveBeenCalledTimes(1);
    expect(onRenderResult).toHaveBeenCalledWith({ success: true });
  });
});
