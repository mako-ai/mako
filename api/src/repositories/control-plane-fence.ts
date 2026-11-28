import { AsyncLocalStorage } from "node:async_hooks";
import mongoose, { type ClientSession } from "mongoose";
import { hasInjectedPgTestDb, hasPostgresConfig } from "../database/pg/client";

const sessions = new AsyncLocalStorage<ClientSession>();
export const controlPlaneSession = () => sessions.getStore();
export const CONTROL_PLANE_DOMAIN = "control-plane-small-v1";
type Owner = "mongo" | "pg";

function isStandaloneServer(): boolean {
  const client = mongoose.connection.getClient() as unknown as {
    topology?: {
      description?: { type: string; servers: Map<string, { type: string }> };
    };
  };
  const topology = client.topology?.description;
  // A direct connection to a replica set also has "Single" topology.
  return (
    topology?.type === "Single" &&
    topology.servers.size === 1 &&
    [...topology.servers.values()][0]?.type === "Standalone"
  );
}

function fences() {
  return mongoose.connection.collection<{
    _id: string;
    owner: Owner;
    serial: number;
    cutoverAt?: Date;
    standaloneOnly?: boolean;
  }>("migration_writer_fences");
}

function ownerOf(row: { owner: Owner } | null): Owner {
  if (row?.owner === "mongo" || row?.owner === "pg") return row.owner;
  throw new Error("Invalid control-plane writer fence");
}

function findFence() {
  return fences().findOne(
    { _id: CONTROL_PLANE_DOMAIN },
    { readPreference: "primary", readConcern: { level: "majority" } },
  );
}

// This row is monotonic. Only the activation transaction can change mongo to pg.
async function readOwner(): Promise<Owner> {
  const row = await findFence();
  if (row) return ownerOf(row);
  const collection = fences();
  await collection.updateOne(
    { _id: CONTROL_PLANE_DOMAIN },
    { $setOnInsert: { owner: "mongo", serial: 0 } },
    { upsert: true, writeConcern: { w: "majority" } },
  );
  return ownerOf(
    await collection.findOne(
      { _id: CONTROL_PLANE_DOMAIN },
      { readPreference: "primary" },
    ),
  );
}

// Both the mutation and this lock live in the SAME Mongo transaction. An
// expired session or a dead instance cannot commit a late Mongo write.
async function withFence<T>(
  work: (
    owner: Owner,
    session: ClientSession,
    standaloneOnly: boolean,
  ) => Promise<T>,
): Promise<T> {
  return mongoose.connection.getClient().withSession(session =>
    session.withTransaction(
      async () => {
        const row = await fences().findOneAndUpdate(
          { _id: CONTROL_PLANE_DOMAIN },
          { $inc: { serial: 1 } },
          { returnDocument: "after", session },
        );
        return sessions.run(session, () =>
          work(ownerOf(row), session, row?.standaloneOnly === true),
        );
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
  verifyPreparedWriters?: () => void | Promise<void>,
): Promise<"activated" | "already active"> {
  const state = await findFence();
  if (state && ownerOf(state) === "pg") return "already active";
  if (isStandaloneServer()) {
    throw new Error("Cutover requires a Mongo replica set or mongos");
  }
  await verifyPreparedWriters?.();
  if (!state) await readOwner();
  return withFence(async (owner, session, standaloneOnly) => {
    if (standaloneOnly) {
      throw new Error(
        "This database served unfenced standalone writes; cutover requires a separately verified drain",
      );
    }
    if (owner === "pg") return "already active";
    const cutoverAt = new Date();
    await copyAndVerify(cutoverAt);
    await fences().updateOne(
      { _id: CONTROL_PLANE_DOMAIN, owner: "mongo" },
      { $set: { owner: "pg", cutoverAt } },
      { session },
    );
    return "activated";
  });
}

export async function publishedCutoverTime(): Promise<Date> {
  const state = await findFence();
  if (state?.owner !== "pg" || !(state.cutoverAt instanceof Date)) {
    throw new Error("Missing committed Mongo handoff");
  }
  return state.cutoverAt;
}

const usePg = Symbol("writer changed to Postgres");

export function createControlPlaneRepo<T extends object>(
  domain: string,
  pg: T,
  mongo: T,
  reads: readonly (keyof T)[],
): T {
  const readMethods = new Set<PropertyKey>(reads);
  // Classify only reads. A newly added method automatically takes the write fence.
  return new Proxy({} as T, {
    get(target, prop, receiver) {
      if (Object.hasOwn(target, prop)) {
        return Reflect.get(target, prop, receiver);
      }
      // Only Release 2 sets this on the new image, after the CI handoff.
      if (process.env.MAKO_CONTROL_PLANE_PG_ACTIVE === "1") {
        const method = Reflect.get(pg, prop);
        return typeof method === "function" ? method.bind(pg) : method;
      }
      const testFallback = process.env.MAKO_TEST_MONGO_FALLBACK;
      if (
        !process.env.K_SERVICE &&
        process.env.NODE_ENV !== "production" &&
        process.env.MAKO_CONTROL_PLANE_FENCE_V1 !== "1" &&
        (hasInjectedPgTestDb() ||
          process.env.NODE_ENV === "test" ||
          process.env.VITEST ||
          testFallback === "1" ||
          testFallback === "0")
      ) {
        const hasPg = hasPostgresConfig();
        if (!hasPg && testFallback === "0") {
          throw new Error(
            `[${domain}] Strict control-plane tests require a Postgres database`,
          );
        }
        const fixture = hasPg ? pg : mongo;
        const method = Reflect.get(fixture, prop);
        return typeof method === "function" ? method.bind(fixture) : method;
      }
      const method = Reflect.get(mongo, prop);
      if (typeof method !== "function") return method;
      return async (...args: unknown[]) => {
        if ((await readOwner()) === "mongo") {
          if (readMethods.has(prop)) return Reflect.apply(method, mongo, args);
          if (isStandaloneServer()) {
            if (
              process.env.K_SERVICE ||
              process.env.MAKO_CONTROL_PLANE_FENCE_V1 === "1"
            ) {
              throw new Error(
                "A prepared control-plane writer requires a Mongo replica set or mongos",
              );
            }
            // Pin this source before a nontransactional write. Even after conversion
            // to a replica set, activation cannot race a delayed standalone writer.
            const pin = await fences().updateOne(
              { _id: CONTROL_PLANE_DOMAIN, owner: "mongo" },
              { $set: { standaloneOnly: true } },
              { writeConcern: { w: "majority" } },
            );
            if (pin.matchedCount !== 1) {
              throw new Error("Standalone writer lost Mongo ownership");
            }
            return Reflect.apply(method, mongo, args);
          }
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
