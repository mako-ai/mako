/**
 * Test-only: give a workspace the connections its fixtures name.
 *
 * Consoles and flows may only store a connection id of their own
 * workspace, so a fixture that names an id must own a row with it. Each id
 * is (re)assigned to `workspaceId`; an id another test's workspace held
 * moves here.
 */
import { Types } from "mongoose";
import {
  DatabaseConnection,
  SourceConnection,
} from "../database/workspace-schema";

export async function seedTestConnections(
  workspaceId: string,
  ids: { database?: string[]; source?: string[] },
): Promise<void> {
  const ws = new Types.ObjectId(workspaceId);
  for (const id of ids.database ?? []) {
    await DatabaseConnection.collection.updateOne(
      { _id: new Types.ObjectId(id) },
      { $set: { workspaceId: ws, name: `db-${id}`, type: "postgresql" } },
      { upsert: true },
    );
  }
  for (const id of ids.source ?? []) {
    await SourceConnection.collection.updateOne(
      { _id: new Types.ObjectId(id) },
      { $set: { workspaceId: ws, name: `src-${id}`, type: "stripe" } },
      { upsert: true },
    );
  }
}
