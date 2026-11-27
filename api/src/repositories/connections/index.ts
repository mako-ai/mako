/**
 * Phase 2A-1 (`connections`) repository singleton & barrel export.
 *
 * All runtime callers import `connectionsRepo` from here. Defaults to
 * `mongo_only` when `POSTGRES_URL` is unset (zero Postgres calls on hot paths).
 */
import { DualConnectionsRepository } from "./dual.repo";

export const connectionsRepo = new DualConnectionsRepository();

export * from "./crypto";
export * from "./dual.repo";
export * from "./mapper";
export * from "./mongo.repo";
export * from "./pg.repo";
export * from "./types";
