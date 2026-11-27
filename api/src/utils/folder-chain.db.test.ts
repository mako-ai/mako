/**
 * Console folder inheritance walks (folder-chain.ts + ConsoleManager)
 * against PGlite: one query per tree level for a whole batch,
 * scoped to the workspace, and terminating on a parentId cycle.
 *
 * Run: npx tsx src/utils/folder-chain.db.test.ts
 */
import assert from "node:assert/strict";
import {
  ensureTestWorkspace,
  ensureTestUser,
  setupPgTestDb,
} from "../test-support/pg-test";
import { consoleFolders } from "../database/pg/schema";
import { generateObjectIdHex, objectIdToUuid } from "../database/pg/id-codec";
import {
  consolesChartsRepo,
  type CreateConsoleFolderInput,
} from "../repositories/consoles-charts";

import type { ISavedConsole } from "../database/workspace-schema";
import { ConsoleManager } from "./console-manager";
import { FolderChainCache, MAX_FOLDER_DEPTH } from "./folder-chain";

async function main(): Promise<void> {
  const h = await setupPgTestDb();
  const ws = generateObjectIdHex();
  const otherWs = generateObjectIdHex();
  const folder = async (
    fields: Pick<CreateConsoleFolderInput, "name" | "access" | "parentId">,
  ) =>
    (
      await consolesChartsRepo.createConsoleFolder({
        workspaceId: ws,
        ownerId: "owner",
        ...fields,
      })
    ).id;

  try {
    const workspace = await ensureTestWorkspace(h.db, { id: ws });
    await ensureTestWorkspace(h.db, { id: otherWs });
    await ensureTestUser(h.db, { id: "owner" });
    // root (workspace) > mid (private) > leaf (private)
    const root = await folder({ name: "root", access: "workspace" });
    const mid = await folder({
      name: "mid",
      access: "private",
      parentId: root,
    });
    const leaf = await folder({
      name: "leaf",
      access: "private",
      parentId: mid,
    });
    // A second, private-only chain.
    const lone = await folder({ name: "lone", access: "private" });

    // Batch prefetch: one query per level, not per console per level.
    let queries = 0;
    const counting = FolderChainCache.withLoader(async ids => {
      queries++;
      return consolesChartsRepo.findConsoleFoldersByIds(
        ws.toString(),
        ids.map(String),
      );
    });
    await counting.prefetch([
      String(leaf),
      String(leaf),
      String(mid),
      String(lone),
    ]);
    assert.equal(
      queries,
      2,
      "one query per level: {leaf, mid, lone}, then {root}",
    );
    assert.deepEqual(
      counting.chain(String(leaf)).map(f => f.name),
      ["leaf", "mid", "root"],
    );

    const manager = new ConsoleManager();
    const privateConsole = (folderId: string, workspaceId = ws) =>
      ({
        _id: generateObjectIdHex(),
        workspaceId,
        folderId,
        access: "private",
        owner_id: "someone-else",
        createdBy: "someone-else",
      }) as unknown as ISavedConsole;

    // Inherits workspace access from the root.
    assert.equal(
      await manager.canReadWithInheritance(privateConsole(leaf), "reader"),
      true,
    );
    assert.equal(
      await manager.canReadWithInheritance(privateConsole(lone), "reader"),
      false,
    );
    // Shared, prefetched cache gives the same answers.
    assert.equal(
      await manager.canReadWithInheritance(privateConsole(leaf), "reader", {
        folders: counting,
      }),
      true,
    );

    // Workspace scoping: the same folder ids seen from another workspace
    // are not found, so nothing is inherited.
    assert.equal(
      await manager.canReadWithInheritance(
        privateConsole(leaf, otherWs),
        "reader",
      ),
      false,
    );

    // A parentId cycle (a <-> b, both private) terminates.
    const a = generateObjectIdHex();
    const b = generateObjectIdHex();
    const aUuid = objectIdToUuid(a);
    const bUuid = objectIdToUuid(b);
    await h.db.insert(consoleFolders).values([
      {
        id: aUuid,
        workspaceId: workspace.uuid,
        name: "a",
        access: "private",
        parentId: bUuid,
      },
      {
        id: bUuid,
        workspaceId: workspace.uuid,
        name: "b",
        access: "private",
        parentId: aUuid,
      },
    ]);
    assert.equal(
      await manager.canReadWithInheritance(privateConsole(a), "reader"),
      false,
    );
    const cyc = FolderChainCache.forWorkspace(ws);
    assert.deepEqual(
      (await cyc.chainOf(String(a))).map(f => f.name),
      ["a", "b"],
    );

    // A very deep chain is cut at MAX_FOLDER_DEPTH.
    let parent: string | undefined;
    for (let i = 0; i < MAX_FOLDER_DEPTH + 10; i++) {
      parent = await folder({
        name: `d${i}`,
        access: "private",
        parentId: parent,
      });
    }
    const deep = FolderChainCache.forWorkspace(ws);
    assert.equal((await deep.chainOf(String(parent))).length, MAX_FOLDER_DEPTH);

    console.info("folder-chain.db.test: ok");
  } finally {
    await h.close();
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
