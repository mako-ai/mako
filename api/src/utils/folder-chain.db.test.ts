/**
 * Console folder inheritance walks (folder-chain.ts + ConsoleManager)
 * against an in-memory Mongo: one query per tree level for a whole batch,
 * scoped to the workspace, and terminating on a parentId cycle.
 *
 * Run: npx tsx src/utils/folder-chain.db.test.ts
 */
import assert from "node:assert/strict";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Types } from "mongoose";

import {
  ConsoleFolder,
  type ISavedConsole,
} from "../database/workspace-schema";
import { ConsoleManager } from "./console-manager";
import { FolderChainCache, MAX_FOLDER_DEPTH } from "./folder-chain";

async function main(): Promise<void> {
  const mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  const ws = new Types.ObjectId();
  const otherWs = new Types.ObjectId();
  const folder = async (fields: Record<string, unknown>) => {
    const _id = new Types.ObjectId();
    await ConsoleFolder.collection.insertOne({
      _id,
      workspaceId: ws,
      ownerId: "owner",
      ...fields,
    });
    return _id;
  };

  try {
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
      return (await ConsoleFolder.find({ _id: { $in: ids }, workspaceId: ws })
        .select("name access isPrivate parentId")
        .lean()) as never;
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
    const privateConsole = (folderId: Types.ObjectId, workspaceId = ws) =>
      ({
        _id: new Types.ObjectId(),
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
    const a = new Types.ObjectId();
    const b = new Types.ObjectId();
    await ConsoleFolder.collection.insertMany([
      { _id: a, workspaceId: ws, name: "a", access: "private", parentId: b },
      { _id: b, workspaceId: ws, name: "b", access: "private", parentId: a },
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
    let parent: Types.ObjectId | undefined;
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
    await mongoose.disconnect();
    await mongo.stop();
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
