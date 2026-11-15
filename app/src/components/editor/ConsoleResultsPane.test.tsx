// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import type { ComponentProps } from "react";

const resultsTableProps: Array<Record<string, unknown>> = [];
vi.mock("./lazy-tabs", () => ({
  ResultsTable: (props: Record<string, unknown>) => {
    resultsTableProps.push(props);
    return <div data-testid="results-table" />;
  },
}));
vi.mock("../ConsoleExecutionsPanel", () => ({ default: () => null }));
vi.mock("../ScheduledRunsPanel", () => ({ default: () => null }));

import { ConsoleResultsPane } from "./ConsoleResultsPane";

const actions = {
  selectBottomPanel: vi.fn(),
  setChartSpec: vi.fn(),
  setViewMode: vi.fn(),
  reportChartRender: vi.fn(),
  previousPage: vi.fn(),
  nextPage: vi.fn(),
  download: vi.fn(),
};

const props = (
  over: Partial<ComponentProps<typeof ConsoleResultsPane>> = {},
): ComponentProps<typeof ConsoleResultsPane> => ({
  tabId: "t1",
  isSaved: true,
  hasSchedule: false,
  bottomPanel: "results",
  results: null,
  chartSpec: null,
  viewMode: "table",
  actions,
  executions: [],
  executionsLoading: false,
  executionsError: null,
  scheduledRuns: [],
  scheduledRunsLoading: false,
  scheduledRunsError: null,
  ...over,
});

describe("ConsoleResultsPane", () => {
  it("hands ResultsTable the same callbacks across re-renders", () => {
    resultsTableProps.length = 0;
    const { rerender } = render(<ConsoleResultsPane {...props()} />);
    rerender(<ConsoleResultsPane {...props({ viewMode: "json" })} />);
    expect(resultsTableProps).toHaveLength(2);
    const [first, second] = resultsTableProps;
    for (const key of [
      "onChartSpecChange",
      "onViewModeChange",
      "onChartRenderError",
      "onChartRenderSuccess",
      "onPreviousPage",
      "onNextPage",
      "onDownload",
    ]) {
      expect(second[key], key).toBe(first[key]);
    }
  });

  it("binds the tab id into each callback", () => {
    resultsTableProps.length = 0;
    render(<ConsoleResultsPane {...props({ tabId: "abc" })} />);
    const p = resultsTableProps[0] as {
      onNextPage: () => void;
      onDownload: (f: "csv") => void;
      onChartRenderError: (e: string) => void;
    };
    p.onNextPage();
    p.onDownload("csv");
    p.onChartRenderError("boom");
    expect(actions.nextPage).toHaveBeenCalledWith("abc");
    expect(actions.download).toHaveBeenCalledWith("abc", "csv");
    expect(actions.reportChartRender).toHaveBeenCalledWith("abc", {
      success: false,
      error: "boom",
    });
  });
});
