import { beforeEach, describe, expect, it, vi } from "vitest";
import { validateDuckDBQuery } from "./validation";
import { executeDashboardSql } from "./commands";

vi.mock("./commands", () => ({
  executeDashboardSql: vi.fn(),
}));

describe("validateDuckDBQuery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("forwards the abort signal to dashboard SQL execution", async () => {
    const controller = new AbortController();

    vi.mocked(executeDashboardSql).mockResolvedValue({
      rows: [],
      rowCount: 0,
      fields: [{ name: "id", type: "INTEGER" }],
    } as any);

    const result = await validateDuckDBQuery({
      dashboardId: "dashboard-1",
      dataSourceId: "source-1",
      sql: "select 1",
      signal: controller.signal,
    });

    expect(result).toEqual({
      valid: true,
      fields: ["id"],
      rowCount: 0,
    });
    expect(executeDashboardSql).toHaveBeenCalledWith(
      expect.objectContaining({
        dashboardId: "dashboard-1",
        dataSourceId: "source-1",
        signal: controller.signal,
      }),
    );
  });
});
