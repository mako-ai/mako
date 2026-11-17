import { describe, expect, it } from "vitest";
import { previewHostSuffix } from "./preview-host";

describe("previewHostSuffix", () => {
  it("reads the US domain from a preview URL", () => {
    expect(previewHostSuffix("https://5173-sbx-a.e2b.app/")).toBe(".e2b.app");
  });

  it("reads the EU domain from a preview URL", () => {
    expect(previewHostSuffix("https://5173-sbx-a.e2b-juliett.dev/x?y=1")).toBe(
      ".e2b-juliett.dev",
    );
  });

  it("falls back to .e2b.app without a usable URL", () => {
    expect(previewHostSuffix(undefined)).toBe(".e2b.app");
    expect(previewHostSuffix("not a url")).toBe(".e2b.app");
    expect(previewHostSuffix("http://localhost:5173")).toBe(".e2b.app");
  });
});
