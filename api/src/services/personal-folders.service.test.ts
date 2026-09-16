/**
 * Personal folders service — against real Mongoose models (in-memory Mongo).
 *
 * The property that matters most here is isolation: a personal folder must be
 * invisible and unreachable to every user but its author, including workspace
 * admins, because the (workspaceId, userId) filter is the ONLY thing standing
 * in for an ACL. The rest covers the limits and the set semantics that make
 * dragging an app in twice harmless.
 *
 * Run: npx tsx src/services/personal-folders.service.test.ts
 */
import assert from "node:assert/strict";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Types } from "mongoose";

import { PersonalFolder } from "../database/workspace-schema";
import {
  createPersonalFolder,
  deletePersonalFolder,
  listPersonalFolders,
  renamePersonalFolder,
  updatePersonalFolderItems,
  MAX_FOLDERS_PER_KIND,
  MAX_FOLDER_NAME_LENGTH,
  MAX_ITEMS_PER_FOLDER,
} from "./personal-folders.service";

const WS = new Types.ObjectId().toString();
const OTHER_WS = new Types.ObjectId().toString();
const ALICE = { workspaceId: WS, userId: "alice" };
const BOB = { workspaceId: WS, userId: "bob" };

/** Unwrap a result that must have succeeded. */
function ok<T>(
  result: { ok: true; value: T } | { ok: false; error: string },
): T {
  assert.ok(result.ok, `expected ok, got ${JSON.stringify(result)}`);
  return result.value;
}

async function main(): Promise<void> {
  const mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());

  try {
    // ── create + list: a folder comes back to its author ──
    {
      const created = ok(
        await createPersonalFolder(ALICE, { name: "  Daily  " }),
      );
      assert.equal(created.name, "Daily", "name is trimmed");
      assert.equal(created.kind, "app", "kind defaults to app");
      assert.deepEqual(created.items, []);

      const folders = await listPersonalFolders(ALICE);
      assert.equal(folders.length, 1);
      assert.equal(folders[0].id, created.id);
    }

    // ── isolation: Bob sees none of Alice's folders and cannot touch them ──
    {
      assert.deepEqual(await listPersonalFolders(BOB), []);

      const alices = (await listPersonalFolders(ALICE))[0];

      const renamed = await renamePersonalFolder(BOB, {
        folderId: alices.id,
        name: "Hijacked",
      });
      assert.equal(renamed.ok, false);
      assert.equal(renamed.ok === false && renamed.status, 404);

      const deleted = await deletePersonalFolder(BOB, alices.id);
      assert.equal(deleted.ok, false);
      assert.equal(deleted.ok === false && deleted.status, 404);

      const items = await updatePersonalFolderItems(BOB, {
        folderId: alices.id,
        add: ["sneaky-app"],
      });
      assert.equal(items.ok, false);
      assert.equal(items.ok === false && items.status, 404);

      // And Alice's folder is untouched by any of it.
      const after = (await listPersonalFolders(ALICE))[0];
      assert.equal(after.name, "Daily");
      assert.deepEqual(after.items, []);
    }

    // ── isolation: the same user in another workspace sees nothing ──
    {
      const elsewhere = await listPersonalFolders({
        workspaceId: OTHER_WS,
        userId: "alice",
      });
      assert.deepEqual(elsewhere, [], "folders do not leak across workspaces");
    }

    // ── items are a set: adding twice is idempotent, remove wins ──
    {
      const folder = (await listPersonalFolders(ALICE))[0];

      const once = ok(
        await updatePersonalFolderItems(ALICE, {
          folderId: folder.id,
          add: ["billing", "churn"],
        }),
      );
      assert.deepEqual(once.items, ["billing", "churn"]);

      const twice = ok(
        await updatePersonalFolderItems(ALICE, {
          folderId: folder.id,
          add: ["billing"],
        }),
      );
      assert.deepEqual(twice.items, ["billing", "churn"], "no duplicate row");

      const both = ok(
        await updatePersonalFolderItems(ALICE, {
          folderId: folder.id,
          add: ["churn"],
          remove: ["churn"],
        }),
      );
      assert.deepEqual(both.items, ["billing"], "remove wins over add");

      const cleaned = ok(
        await updatePersonalFolderItems(ALICE, {
          folderId: folder.id,
          add: ["  spaced  ", "", "x".repeat(500)],
        }),
      );
      assert.deepEqual(
        cleaned.items,
        ["billing", "spaced"],
        "keys are trimmed; blank and over-long keys are dropped",
      );
    }

    // ── a malformed id is a 404, never a cast crash ──
    {
      const result = await renamePersonalFolder(ALICE, {
        folderId: "not-an-object-id",
        name: "x",
      });
      assert.equal(result.ok, false);
      assert.equal(result.ok === false && result.status, 404);
    }

    // ── a blank or over-long name is rejected ──
    {
      for (const name of ["", "   ", "n".repeat(MAX_FOLDER_NAME_LENGTH + 1)]) {
        const result = await createPersonalFolder(ALICE, { name });
        assert.equal(result.ok, false, `rejected: ${JSON.stringify(name)}`);
        assert.equal(result.ok === false && result.status, 400);
      }
    }

    // ── delete removes the grouping and returns 404 the second time ──
    {
      const folder = (await listPersonalFolders(ALICE))[0];
      assert.ok(ok(await deletePersonalFolder(ALICE, folder.id)));
      assert.deepEqual(await listPersonalFolders(ALICE), []);

      const again = await deletePersonalFolder(ALICE, folder.id);
      assert.equal(again.ok, false);
      assert.equal(again.ok === false && again.status, 404);
    }

    // ── the per-kind folder cap is enforced ──
    {
      await PersonalFolder.deleteMany({});
      const docs = Array.from({ length: MAX_FOLDERS_PER_KIND }, (_, i) => ({
        workspaceId: new Types.ObjectId(WS),
        userId: "alice",
        kind: "app",
        name: `folder-${i}`,
        items: [],
      }));
      await PersonalFolder.insertMany(docs);

      const overflow = await createPersonalFolder(ALICE, { name: "one more" });
      assert.equal(overflow.ok, false);
      assert.equal(overflow.ok === false && overflow.status, 409);

      // A different kind has its own budget.
      const otherKind = await createPersonalFolder(ALICE, {
        name: "notebooks one",
        kind: "notebook",
      });
      assert.equal(otherKind.ok, true, "the cap is per kind, not per user");
    }

    // ── the per-folder item cap is enforced ──
    {
      await PersonalFolder.deleteMany({});
      const folder = ok(await createPersonalFolder(ALICE, { name: "Big" }));
      const many = Array.from(
        { length: MAX_ITEMS_PER_FOLDER + 1 },
        (_, i) => `app-${i}`,
      );
      const result = await updatePersonalFolderItems(ALICE, {
        folderId: folder.id,
        add: many,
      });
      assert.equal(result.ok, false);
      assert.equal(result.ok === false && result.status, 409);

      const stored = (await listPersonalFolders(ALICE))[0];
      assert.deepEqual(stored.items, [], "a rejected add writes nothing");
    }

    console.log("personal-folders service tests passed");
  } finally {
    await mongoose.disconnect();
    await mongo.stop();
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
