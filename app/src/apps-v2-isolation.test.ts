import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const SOURCES = [
  "./store/appV2Store.ts",
  "./components/AppsV2Explorer.tsx",
  "./components/AppV2ProjectView.tsx",
  "./components/AppV2FileEditor.tsx",
  "./apps-v2-runtime/shell.ts",
] as const;

const FORBIDDEN_IMPORTS = [
  /from\s+["']\.\.\/store\/appStore["']/,
  /from\s+["']\.\/AppsExplorer["']/,
  /from\s+["']\.\/AppRenderer["']/,
  /from\s+["']\.\/AppFileEditor["']/,
] as const;

describe("Apps v2 frontend isolation", () => {
  it.each(SOURCES)(
    "%s does not import Apps v1 components or store",
    async file => {
      const source = await readFile(new URL(file, import.meta.url), "utf8");
      for (const forbidden of FORBIDDEN_IMPORTS) {
        expect(source).not.toMatch(forbidden);
      }
    },
  );

  it("routes the mobile tab close button through the guarded close path", async () => {
    const source = await readFile(
      new URL("./components/Editor.tsx", import.meta.url),
      "utf8",
    );
    const mobileCloseButton = source.match(
      /aria-label=\{`Close \$\{tab\.title\}`\}[\s\S]*?<\/IconButton>/,
    )?.[0];

    expect(mobileCloseButton).toContain("closeConsole(tab.id)");
    expect(mobileCloseButton).not.toContain("cleanupTab(tab.id)");
  });
});
