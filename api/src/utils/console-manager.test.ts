import assert from "node:assert/strict";
import mongoose, { Types } from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { ConsoleFolder, SavedConsole } from "../database/workspace-schema";
import { ConsoleManager } from "./console-manager";

const WORKSPACE_ID = new Types.ObjectId().toString();
const USER_ID = "user-1";

async function resetCollections() {
  await Promise.all([SavedConsole.deleteMany({}), ConsoleFolder.deleteMany({})]);
}

async function testSavePreservesSlashNames() {
  await resetCollections();
  const manager = new ConsoleManager();

  const saved = await manager.saveConsole(
    "finance/revenue",
    "select 1",
    WORKSPACE_ID,
    USER_ID,
    undefined,
    undefined,
    undefined,
    { id: new Types.ObjectId().toString(), access: "private" },
  );

  const persisted = await SavedConsole.findById(saved._id).lean();
  const exactMatch = await manager.getConsoleByPath(
    "finance/revenue",
    WORKSPACE_ID,
  );

  assert.equal(persisted?.name, "finance/revenue");
  assert.equal(persisted?.folderId, undefined);
  assert.equal(
    await ConsoleFolder.countDocuments({ workspaceId: WORKSPACE_ID }),
    0,
  );
  assert.equal(exactMatch?.name, "finance/revenue");
  assert.equal(await manager.getConsoleByPath("revenue", WORKSPACE_ID), null);
}

async function testExplicitFolderIdControlsPlacement() {
  await resetCollections();
  const manager = new ConsoleManager();
  const folder = await manager.createFolder("Finance", WORKSPACE_ID, USER_ID);

  const saved = await manager.saveConsole(
    "north/america",
    "select 1",
    WORKSPACE_ID,
    USER_ID,
    undefined,
    undefined,
    undefined,
    { folderId: folder._id.toString(), access: "private" },
  );

  const persisted = await SavedConsole.findById(saved._id).lean();
  const exactMatch = await manager.getConsoleByPath(
    "north/america",
    WORKSPACE_ID,
    folder._id.toString(),
  );

  assert.equal(persisted?.name, "north/america");
  assert.equal(persisted?.folderId?.toString(), folder._id.toString());
  assert.equal(
    await ConsoleFolder.countDocuments({ workspaceId: WORKSPACE_ID }),
    1,
  );
  assert.equal(exactMatch?.name, "north/america");
}

async function testRenamePreservesSlashNames() {
  await resetCollections();
  const manager = new ConsoleManager();
  const saved = await manager.saveConsole(
    "initial",
    "select 1",
    WORKSPACE_ID,
    USER_ID,
    undefined,
    undefined,
    undefined,
    { access: "private" },
  );

  const success = await manager.renameConsole(
    saved._id.toString(),
    "a/b/c",
    WORKSPACE_ID,
    USER_ID,
  );
  const persisted = await SavedConsole.findById(saved._id).lean();

  assert.equal(success, true);
  assert.equal(persisted?.name, "a/b/c");
  assert.equal(persisted?.folderId, undefined);
  assert.equal(
    await ConsoleFolder.countDocuments({ workspaceId: WORKSPACE_ID }),
    0,
  );
}

async function main() {
  const mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  try {
    await testSavePreservesSlashNames();
    await testExplicitFolderIdControlsPlacement();
    await testRenamePreservesSlashNames();
  } finally {
    await mongoose.disconnect();
    await mongo.stop();
  }
}

void main().then(() => {
  // eslint-disable-next-line no-console -- self-running test, not API code
  console.log("console-manager.test.ts: all assertions passed");
});
