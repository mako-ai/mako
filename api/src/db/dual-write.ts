import type { IUser } from "../database/schema";
import { loggers } from "../logging";
import { toPgId, toPgIdOrNull } from "./ids";
import { connectionsRepository, usersRepository } from "./repositories";

const log = loggers.db();

/**
 * Transitional Mongo -> Postgres mirrors for the two domains whose READS have
 * been cut over to Postgres while their WRITES still land in Mongo:
 *
 *   - users:       `AUTH_PERSISTENCE=postgres` joins sessions to `users` in PG,
 *                  so every Mongo user write must be mirrored or new/updated
 *                  users can't log in.
 *   - connections: `CONNECTIONS_PERSISTENCE=postgres` resolves connections
 *                  (incl. decrypted credentials) from PG for query execution,
 *                  so creates/updates AND deletes must be mirrored — a stale
 *                  PG row after a Mongo delete would keep dead credentials
 *                  usable.
 *
 * These are NOT a general dual-write layer (the old `POSTGRES_DUAL_WRITE`
 * blanket flag is gone — it silently missed `updateOne`/`findOneAndUpdate`/
 * delete paths and fired inside Mongo transactions before commit). Each mirror
 * is enabled only by the read-cutover flag that requires it, and both
 * disappear once the domain's writes move natively to Postgres in the big-bang
 * cutover (see `api/src/db/README.md`).
 *
 * Mirrors are best-effort: failures are logged, never thrown; the upsert
 * backfill (`db:backfill`) converges any drift.
 */
function authOnPostgres(): boolean {
  return process.env.AUTH_PERSISTENCE === "postgres";
}

function connectionsOnPostgres(): boolean {
  return process.env.CONNECTIONS_PERSISTENCE === "postgres";
}

export async function mirrorUser(user: IUser): Promise<void> {
  if (!authOnPostgres()) return;
  try {
    await usersRepository.upsert({
      id: toPgId(String(user._id)),
      email: String(user.email).toLowerCase(),
      hashedPassword: user.hashedPassword ?? null,
      emailVerified: user.emailVerified ?? false,
      onboarding: (user.onboarding as never) ?? null,
    });
  } catch (error) {
    log.error("mirror user -> postgres failed", {
      error,
      userId: String(user._id),
    });
  }
}

export async function mirrorDatabaseConnection(conn: {
  _id: unknown;
  workspaceId: unknown;
  name: string;
  type: string;
  // Plaintext when read off a Mongoose doc (getters decrypt); the repository
  // re-encrypts on write.
  connection: Record<string, unknown>;
  isDemo?: boolean;
  createdBy: string;
  lastConnectedAt?: Date | null;
}): Promise<void> {
  if (!connectionsOnPostgres()) return;
  try {
    await connectionsRepository.upsert({
      id: toPgId(String(conn._id)),
      workspaceId: toPgId(String(conn.workspaceId)),
      name: conn.name,
      type: conn.type as never,
      connection: conn.connection ?? {},
      isDemo: conn.isDemo ?? false,
      createdBy: toPgId(String(conn.createdBy)),
      lastConnectedAt: conn.lastConnectedAt ?? null,
    });
  } catch (error) {
    log.error("mirror database_connection -> postgres failed", {
      error,
      connectionId: String(conn._id),
    });
  }
}

/**
 * Mirror a Mongo connection delete. Unlike the save mirror this is awaited by
 * the delete route and never swallowed silently into a stale-credential hole:
 * on failure we log loudly; the next `db:backfill --prune` reconciles.
 */
export async function mirrorDatabaseConnectionDelete(
  connectionId: string,
): Promise<void> {
  if (!connectionsOnPostgres()) return;
  try {
    await connectionsRepository.delete(toPgId(connectionId));
  } catch (error) {
    log.error("mirror database_connection delete -> postgres failed", {
      error,
      connectionId,
    });
  }
}

export { toPgIdOrNull };
