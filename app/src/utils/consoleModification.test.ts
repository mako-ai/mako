import { describe, expect, it } from "vitest";
import { buildModificationDiff } from "./consoleModification";

describe("buildModificationDiff", () => {
  it("keeps patch previews focused on the modified range", () => {
    const diff = buildModificationDiff("one\ntwo\nthree\nfour", {
      action: "patch",
      content: "TWO",
      startLine: 2,
      endLine: 3,
    });

    expect(diff).toBe("@@ -2,2 +2,1 @@\n-two\n-three\n+TWO");
  });

  it("truncates large replace previews", () => {
    const currentContent = Array.from(
      { length: 140 },
      (_, index) => `old ${index + 1}`,
    ).join("\n");
    const nextContent = Array.from(
      { length: 140 },
      (_, index) => `new ${index + 1}`,
    ).join("\n");

    const diff = buildModificationDiff(currentContent, {
      action: "replace",
      content: nextContent,
    });

    expect(diff).toContain("@@ -1,140 +1,140 @@");
    expect(diff).toContain("diff lines omitted");
    expect(diff.split("\n")).toHaveLength(121);
  });
});
