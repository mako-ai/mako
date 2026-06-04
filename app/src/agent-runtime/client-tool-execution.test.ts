import { describe, expect, it } from "vitest";

import { shouldDetachDashboardToolExecution } from "./client-tool-execution";

describe("shouldDetachDashboardToolExecution", () => {
  it("keeps all dashboard client tools off the awaited stream reader path", () => {
    expect(shouldDetachDashboardToolExecution("enter_edit_mode")).toBe(true);
    expect(shouldDetachDashboardToolExecution("remove_widget")).toBe(true);
    expect(shouldDetachDashboardToolExecution("get_dashboard_state")).toBe(
      true,
    );
  });

  it("does not detach non-dashboard client tools", () => {
    expect(shouldDetachDashboardToolExecution("read_console")).toBe(false);
    expect(shouldDetachDashboardToolExecution("open_console")).toBe(false);
    expect(shouldDetachDashboardToolExecution("get_form_state")).toBe(false);
  });

  it("returns false for unknown tools", () => {
    expect(shouldDetachDashboardToolExecution("not_a_real_tool")).toBe(false);
  });
});
