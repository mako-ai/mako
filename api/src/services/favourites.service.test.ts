/**
 * Favourites service — against real Mongoose models (in-memory Mongo).
 *
 * What matters: isolation (a favourite is unreachable by anyone but its
 * author), idempotent starring, ordered moves that keep sibling positions
 * dense, and the tree rules (no folder inside itself, subtree deletes).
 *
 * Run: npx tsx src/services/favourites.service.test.ts
 */
import assert from "node:assert/strict";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Types } from "mongoose";
import { Favourite } from "../database/workspace-schema";
import {
  addFavourite,
  createFavouriteFolder,
  deleteFavourite,
  listFavourites,
  removeFavouriteByRef,
  updateFavourite,
} from "./favourites.service";

const WS = new Types.ObjectId().toString();
const ALICE = { workspaceId: WS, userId: "alice" };
const BOB = { workspaceId: WS, userId: "bob" };

function ok<T>(
  result: { ok: true; value: T } | { ok: false; error: string },
): T {
  assert.ok(result.ok, `expected ok, got ${JSON.stringify(result)}`);
  return result.value;
}

async function main(): Promise<void> {
  const mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  await Favourite.syncIndexes();
  try {
    // Star twice: one row. Unstar: gone. Unstar again: not an error.
    const star = ok(await addFavourite(ALICE, { kind: "app", refId: "a1" }));
    const again = ok(await addFavourite(ALICE, { kind: "app", refId: "a1" }));
    assert.equal(again.id, star.id, "starring is idempotent");
    assert.equal((await listFavourites(ALICE)).length, 1);
    assert.deepEqual(
      await removeFavouriteByRef(ALICE, { kind: "app", refId: "a1" }),
      {
        removed: true,
      },
    );
    assert.deepEqual(
      await removeFavouriteByRef(ALICE, { kind: "app", refId: "a1" }),
      {
        removed: false,
      },
    );

    // Isolation: Bob sees none of Alice's rows and cannot touch them.
    const folder = ok(await createFavouriteFolder(ALICE, { title: " Sales " }));
    assert.equal(folder.title, "Sales");
    assert.equal((await listFavourites(BOB)).length, 0);
    const bobPatch = await updateFavourite(BOB, folder.id, { title: "Mine" });
    assert.equal(bobPatch.ok, false);
    const bobDelete = await deleteFavourite(BOB, folder.id);
    assert.equal(bobDelete.ok, false);

    // Items in a folder are ordered; a move re-indexes both sides densely.
    const a = ok(
      await addFavourite(ALICE, {
        kind: "app",
        refId: "a",
        parentId: folder.id,
      }),
    );
    const b = ok(
      await addFavourite(ALICE, {
        kind: "app",
        refId: "b",
        parentId: folder.id,
      }),
    );
    const c = ok(await addFavourite(ALICE, { kind: "notebook", refId: "n1" }));
    assert.deepEqual([a.position, b.position, c.position], [0, 1, 1]);
    // c: root position 1 (the folder is root position 0).
    const movedC = ok(
      await updateFavourite(ALICE, c.id, { parentId: folder.id, position: 0 }),
    );
    assert.equal(movedC.parentId, folder.id);
    assert.equal(movedC.position, 0);
    const inFolder = (await listFavourites(ALICE))
      .filter(f => f.parentId === folder.id)
      .map(f => [f.refId, f.position]);
    assert.deepEqual(inFolder, [
      ["n1", 0],
      ["a", 1],
      ["b", 2],
    ]);
    const atRoot = (await listFavourites(ALICE)).filter(
      f => f.parentId === null,
    );
    assert.deepEqual(
      atRoot.map(f => f.position),
      [0],
    );

    // Reorder within the same folder: b to the front.
    ok(await updateFavourite(ALICE, b.id, { position: 0 }));
    assert.deepEqual(
      (await listFavourites(ALICE))
        .filter(f => f.parentId === folder.id)
        .map(f => f.refId),
      ["b", "n1", "a"],
    );

    // A folder cannot be moved into itself or its descendants.
    const sub = ok(
      await createFavouriteFolder(ALICE, { title: "Sub", parentId: folder.id }),
    );
    const cyc = await updateFavourite(ALICE, folder.id, { parentId: sub.id });
    assert.equal(cyc.ok, false);
    const self = await updateFavourite(ALICE, folder.id, {
      parentId: folder.id,
    });
    assert.equal(self.ok, false);

    // Only folders have titles; titles are trimmed and required.
    assert.equal(
      (await updateFavourite(ALICE, a.id, { title: "x" })).ok,
      false,
    );
    assert.equal(
      (await updateFavourite(ALICE, folder.id, { title: "  " })).ok,
      false,
    );
    assert.equal(
      ok(await updateFavourite(ALICE, folder.id, { title: " Ops " })).title,
      "Ops",
    );

    // Deleting a folder removes its whole subtree, and nothing else.
    const deleted = ok(await deleteFavourite(ALICE, folder.id));
    assert.equal(deleted.removed, 5, "folder + sub + 3 items");
    assert.equal((await listFavourites(ALICE)).length, 0);

    // Unknown folder / kind are refused cleanly.
    const badParent = await addFavourite(ALICE, {
      kind: "app",
      refId: "z",
      parentId: new Types.ObjectId().toString(),
    });
    assert.equal(badParent.ok, false);
    const badKind = await addFavourite(ALICE, {
      kind: "flow" as never,
      refId: "z",
    });
    assert.equal(badKind.ok, false);
  } finally {
    await mongoose.disconnect();
    await mongo.stop();
  }
  console.log("favourites.service: ok");
}

void main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
