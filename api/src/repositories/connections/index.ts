/**
 * Connections repository singleton & barrel export (Neon Postgres `pg_only`).
 */
import { createPgFirstRepoProxy } from "../resolve-repo";
import { MongoConnectionsRepository } from "./mongo.repo";
import { PgConnectionsRepository } from "./pg.repo";
import type { ConnectionsRepository } from "./types";

export const connectionsRepo: ConnectionsRepository =
  createPgFirstRepoProxy<ConnectionsRepository>(
    "connections",
    new PgConnectionsRepository(),
    new MongoConnectionsRepository(),
  );

export * from "./crypto";
export * from "./mapper";
export * from "./mongo.repo";
export * from "./pg.repo";
export * from "./types";
