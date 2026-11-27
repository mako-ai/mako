/**
 * Connections repository singleton & barrel export (Neon Postgres `pg_only`).
 */
import { PgConnectionsRepository } from "./pg.repo";
import type { ConnectionsRepository } from "./types";

export const connectionsRepo: ConnectionsRepository =
  new PgConnectionsRepository();

export * from "./crypto";
export * from "./mapper";
export * from "./pg.repo";
export * from "./types";
