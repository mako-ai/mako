import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Guard for apps-v2.md §13.9: the workbench RENDERS state and starts processes
 * on an explicit click — it never "heals". The regression this locks out is
 * real: the mount/restore effect used to call startDevPreview for every app
 * left in dev mode, so remounting a dozen tabs after a recycle cold-started a
 * dozen vite servers and filled the box, with nobody having clicked anything.
 */
const src = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "AppV2Workspace.tsx"),
  "utf8",
);

describe("apps-v2 workbench never heals (apps-v2.md §13.9)", () => {
  it("restores the view on mount without starting a dev server", () => {
    const start = src.indexOf("// Restore the VIEW on reload");
    expect(start).toBeGreaterThan(-1);
    const end = src.indexOf("}, [appId, workspaceId]);", start);
    expect(end).toBeGreaterThan(start);
    // Strip comments first: the effect DESCRIBES the old bug in prose, so we
    // must assert on actual code, not the word appearing in an explanation.
    const effect = src
      .slice(start, end)
      .replace(/\/\/[^\n]*/g, "")
      .replace(/\/\*[\s\S]*?\*\//g, "");
    // Restoring which pane to show is fine; starting a process is not.
    expect(effect).not.toContain("startDevPreview");
    expect(effect).not.toContain("ensureDevServer");
    // It should still reflect real state via the read-only probe.
    expect(effect).toContain("checkDevStatus");
  });
});
