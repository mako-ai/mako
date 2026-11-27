import type { Db } from "mongodb";
import mongoose from "mongoose";
import { MongoDbtRepository } from "./mongo.repo";

const id = "dbt-v1";
type Fence = { _id: string; generation: number; serial: number };
const fences = (db: Db) => db.collection<Fence>("migration_writer_fences");
const majority = { w: "majority" } as const;

function mongo() {
  const db = mongoose.connection.db;
  if (!db) throw new Error("Missing Mongo dbt connection");
  return db;
}

export async function dbtWriterGeneration() {
  const guard = await fences(mongo()).findOne(
    { _id: id },
    { readPreference: "primary", readConcern: { level: "majority" } },
  );
  // A fresh database starts at generation zero.
  if (!guard) {
    await initialize(mongo());
    return 0;
  }
  if (!Number.isSafeInteger(guard.generation)) {
    throw new Error("Invalid dbt writer generation");
  }
  return guard.generation;
}

async function initialize(db: Db) {
  await fences(db).updateOne(
    { _id: id },
    { $setOnInsert: { generation: 0, serial: 0 } },
    { upsert: true, writeConcern: majority },
  );
}

// Called under the exclusive PG admission lock. This waits for any Mongo
// transaction already touching the fence, and invalidates undispatched writes.
export async function drainDbtWriters(db: Db) {
  await initialize(db);
  await fences(db).updateOne(
    { _id: id },
    { $inc: { generation: 1 } },
    { writeConcern: majority },
  );
}

export const generationChanged = Symbol("retry dbt admission");

export async function withDbtWriteFence<T>(
  generation: number,
  write: (repo: MongoDbtRepository) => Promise<T>,
) {
  const db = mongo();
  return mongoose.connection.getClient().withSession(session =>
    session.withTransaction(
      async () => {
        const guard = await fences(db).updateOne(
          { _id: id, generation },
          { $inc: { serial: 1 } },
          { session },
        );
        if (!guard.matchedCount) return generationChanged;
        return write(new MongoDbtRepository(session));
      },
      {
        readPreference: "primary",
        readConcern: { level: "snapshot" },
        writeConcern: majority,
      },
    ),
  );
}
