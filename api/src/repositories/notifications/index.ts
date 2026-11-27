/**
 * Notifications domain repository entry point (Neon Postgres `pg_only`).
 */
import { createPgFirstRepoProxy } from "../resolve-repo";
import { MongoNotificationsRepository } from "./mongo.repo";
import { PgNotificationsRepository } from "./pg.repo";
import type { NotificationsRepository } from "./types";

export * from "./types";
export { MongoNotificationsRepository } from "./mongo.repo";
export { PgNotificationsRepository } from "./pg.repo";

export const notificationsRepo: NotificationsRepository =
  createPgFirstRepoProxy<NotificationsRepository>(
    "notifications",
    new PgNotificationsRepository(),
    new MongoNotificationsRepository(),
  );
