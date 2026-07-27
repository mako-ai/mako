import { describe, expect, it } from "vitest";
import { ACP_NOTEBOOK_FOCUS_TOOLS } from "./acp-notebook-focus";

describe("ACP notebook focus policy", () => {
  it("does not steal focus for read-only notebook inspection", () => {
    expect(ACP_NOTEBOOK_FOCUS_TOOLS.has("read_notebook")).toBe(false);
    expect(ACP_NOTEBOOK_FOCUS_TOOLS.has("search_notebook")).toBe(false);
    expect(ACP_NOTEBOOK_FOCUS_TOOLS.has("read_notebook_cell")).toBe(false);
  });

  it("still surfaces notebook creation and mutations", () => {
    expect(ACP_NOTEBOOK_FOCUS_TOOLS.has("create_notebook")).toBe(true);
    expect(ACP_NOTEBOOK_FOCUS_TOOLS.has("edit_notebook_cell")).toBe(true);
    expect(ACP_NOTEBOOK_FOCUS_TOOLS.has("run_notebook_code_cell")).toBe(true);
  });
});
