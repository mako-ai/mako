import { AsyncLocalStorage } from "node:async_hooks";
import mongoose, { type ClientSession } from "mongoose";
import { createPgFirstRepoProxy } from "./resolve-repo";

const sessions = new AsyncLocalStorage<ClientSession>();
export const controlPlaneSession = () => sessions.getStore();
const id = "control-plane-small-v1";
type Owner = "mongo" | "pg";

function fences() {
  return mongoose.connection.collection<{
    _id: string;
    owner: Owner;
    serial: number;
    cutoverAt?: Date;
  }>("migration_writer_fences");
}

function ownerOf(row: { owner: Owner } | null): Owner {
  if (row?.owner === "mongo" || row?.owner === "pg") return row.owner;
  throw new Error("Invalid control-plane writer fence");
}

// This row is monotonic. Only the activation transaction can change mongo to pg.
async function readOwner(): Promise<Owner> {
  const collection = fences();
  const row = await collection.findOne(
    { _id: id },
    { readPreference: "primary", readConcern: { level: "majority" } },
  );
  if (row) return ownerOf(row);
  await collection.updateOne(
    { _id: id },
    { $setOnInsert: { owner: "mongo", serial: 0 } },
    { upsert: true, writeConcern: { w: "majority" } },
  );
  return ownerOf(
    await collection.findOne({ _id: id }, { readPreference: "primary" }),
  );
}

// Both the mutation and this lock live in the SAME Mongo transaction. An
// expired session or a dead instance cannot commit a late Mongo write.
async function withFence<T>(
  work: (owner: Owner, session: ClientSession) => Promise<T>,
): Promise<T> {
  return mongoose.connection.getClient().withSession(session =>
    session.withTransaction(
      async () => {
        const row = await fences().findOneAndUpdate(
          { _id: id },
          { $inc: { serial: 1 } },
          { returnDocument: "after", session },
        );
        return sessions.run(session, () => work(ownerOf(row), session));
      },
      {
        readPreference: "primary",
        readConcern: { level: "snapshot" },
        writeConcern: { w: "majority" },
      },
    ),
  );
}

export async function activateControlPlane(
  copyAndVerify: (cutoverAt: Date) => Promise<void>,
): Promise<"activated" | "already active"> {
  if ((await readOwner()) === "pg") return "already active";
  return withFence(async (owner, session) => {
    if (owner === "pg") return "already active";
    const cutoverAt = new Date();
    await copyAndVerify(cutoverAt);
    await fences().updateOne(
      { _id: id, owner: "mongo" },
      { $set: { owner: "pg", cutoverAt } },
      { session },
    );
    return "activated";
  });
}

const usePg = Symbol("writer changed to Postgres");

export function createControlPlaneRepo<T extends object>(
  domain: string,
  pg: T,
  mongo: T,
  reads: readonly (keyof T)[],
): T {
  const legacyTests = createPgFirstRepoProxy(domain, pg, mongo);
  const readMethods = new Set<PropertyKey>(reads);
  // Classify only reads. A newly added method automatically takes the write fence.
  return new Proxy({} as T, {
    get(target, prop, receiver) {
      if (Object.hasOwn(target, prop)) {
        return Reflect.get(target, prop, receiver);
      }
      if (
        !process.env.K_SERVICE &&
        process.env.MAKO_CONTROL_PLANE_FENCE_V1 !== "1" &&
        (process.env.NODE_ENV === "test" ||
          process.env.VITEST ||
          process.env.MAKO_TEST_MONGO_FALLBACK === "1")
      ) {
        return Reflect.get(legacyTests, prop);
      }
      const method = Reflect.get(mongo, prop);
      if (typeof method !== "function") return method;
      return async (...args: unknown[]) => {
        if ((await readOwner()) === "mongo") {
          if (readMethods.has(prop)) return Reflect.apply(method, mongo, args);
          const result = await withFence(async owner =>
            owner === "pg" ? usePg : Reflect.apply(method, mongo, args),
          );
          if (result !== usePg) return result;
        }
        const pgMethod = Reflect.get(pg, prop);
        if (typeof pgMethod !== "function") {
          throw new Error("Unknown PG repository method");
        }
        return Reflect.apply(pgMethod, pg, args);
      };
    },
  });
}
