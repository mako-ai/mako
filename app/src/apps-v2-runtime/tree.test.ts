import { describe, expect, it, vi } from "vitest";
import { APP_V2_FILE_SEP } from "../lib/explorer-reveal";
import {
  appV2ProjectIdFromFileNodeId,
  appV2ProjectIdFromRevealNodeId,
  buildAppV2FileNodes,
  prepareAppV2Reveal,
} from "./tree";

describe("Apps v2 file tree node identity", () => {
  it("keeps delimiter text inside the file path", () => {
    const path = `src/with${APP_V2_FILE_SEP}delimiter.ts`;
    const nodes = buildAppV2FileNodes("project-1", [
      {
        path,
        oid: "a".repeat(40),
        size: 12,
        mode: "regular",
      },
    ]);
    const fileNode = nodes[0]?.children?.[0];

    expect(fileNode?.path).toBe(path);
    expect(appV2ProjectIdFromFileNodeId(fileNode?.id ?? "")).toBe("project-1");
    expect(appV2ProjectIdFromRevealNodeId(fileNode?.id ?? "")).toBe(
      "project-1",
    );
  });

  it("prepares the project, worktree, and tree before revealing a file", async () => {
    const calls: string[] = [];
    const projectId = await prepareAppV2Reveal(
      `project-1${APP_V2_FILE_SEP}src/with${APP_V2_FILE_SEP}delimiter.ts`,
      {
        ensureProject: vi.fn(async id => {
          calls.push(`project:${id}`);
        }),
        getOrCreateWorktree: vi.fn(async id => {
          calls.push(`worktree:${id}`);
          return { id: "worktree-1" };
        }),
        loadTree: vi.fn(async id => {
          calls.push(`tree:${id}`);
        }),
      },
    );

    expect(projectId).toBe("project-1");
    expect(calls).toEqual([
      "project:project-1",
      "worktree:project-1",
      "tree:project-1",
    ]);
  });
});
