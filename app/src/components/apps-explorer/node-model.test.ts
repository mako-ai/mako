import { describe, expect, it } from "vitest";
import {
  buildFileNodes,
  folderLabel,
  folderOptionsFor,
  parseNodeId,
} from "./node-model";
import { APP_DIR_SEP, APP_FILE_SEP } from "../../lib/explorer-reveal";
import { folderNodeId } from "../../lib/apps-explorer-tree";
import { starredFolderId, starredRowId } from "../starred/starred-section";
import { shortcutRowId } from "../starred/shortcut-section";

describe("parseNodeId", () => {
  it("recognizes every row kind", () => {
    expect(parseNodeId("a1")).toEqual({
      kind: "app",
      appId: "a1",
      pinned: false,
    });
    expect(parseNodeId(starredRowId("a1"))).toEqual({
      kind: "app",
      appId: "a1",
      pinned: true,
    });
    expect(parseNodeId(shortcutRowId("recently-viewed", "a1"))).toEqual({
      kind: "app",
      appId: "a1",
      pinned: true,
      shortcut: true,
    });
    expect(parseNodeId(folderNodeId("apps/Sales"))).toEqual({
      kind: "folder",
      folderPath: "apps/Sales",
    });
    expect(parseNodeId(starredFolderId("f1"))).toEqual({
      kind: "starfolder",
      favId: "f1",
    });
    expect(parseNodeId(`a1${APP_FILE_SEP}src/App.tsx`)).toEqual({
      kind: "file",
      appId: "a1",
      path: "src/App.tsx",
    });
    expect(parseNodeId(`a1${APP_DIR_SEP}src`)).toEqual({
      kind: "dir",
      appId: "a1",
      path: "src",
    });
  });
});

describe("buildFileNodes", () => {
  it("nests paths, folders first, names sorted", () => {
    const nodes = buildFileNodes("a1", [
      { path: "src/main.tsx" },
      { path: "README.md" },
      { path: "src/App.tsx" },
      { path: "bindings/sales.sql" },
    ] as Parameters<typeof buildFileNodes>[1]);
    expect(nodes.map(n => n.name)).toEqual(["bindings", "src", "README.md"]);
    const src = nodes[1];
    expect(src).toMatchObject({
      id: `a1${APP_DIR_SEP}src`,
      isDirectory: true,
    });
    expect(src.children?.map(c => c.id)).toEqual([
      `a1${APP_FILE_SEP}src/App.tsx`,
      `a1${APP_FILE_SEP}src/main.tsx`,
    ]);
    expect(nodes[2].children).toBeUndefined();
  });
});

describe("folder labels", () => {
  it("reads paths as a person would", () => {
    expect(folderLabel("apps", null)).toBe("Workspace");
    expect(folderLabel("apps/Sales/CH", null)).toBe("Workspace / Sales / CH");
    expect(folderLabel("users/me", "users/me")).toBe("Personal");
    expect(folderLabel("users/me/x", "users/me")).toBe("Personal / x");
    expect(folderLabel("other", null)).toBe("other");
  });

  it("lists workspace then personal folders for the create picker", () => {
    expect(
      folderOptionsFor(["apps/A", "users/me/B", "elsewhere"], "users/me"),
    ).toEqual([
      { path: "apps", label: "Workspace" },
      { path: "apps/A", label: "Workspace / A" },
      { path: "users/me", label: "Personal" },
      { path: "users/me/B", label: "Personal / B" },
    ]);
    expect(folderOptionsFor([], null)).toEqual([
      { path: "apps", label: "Workspace" },
    ]);
  });
});
