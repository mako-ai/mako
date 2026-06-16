import type { IUser } from "../database/schema";
import { toPgId } from "../db/ids";
import { usersRepository } from "../db/repositories";
import { loggers } from "../logging";

const log = loggers.auth();

/**
 * Dual-write a Mongo `User` document into the Postgres `users` table.
 *
 * Used by a Mongoose post-save hook so that, while `AUTH_PERSISTENCE=postgres`,
 * every user create/update (registration, email verification, OAuth, password
 * reset) keeps Postgres current — not just the point-in-time backfill. Without
 * this, a newly-registered user would have a Mongo row but no Postgres row, and
 * the Postgres session store could not validate their session.
 *
 * Best-effort: failures are logged but never thrown. The Mongo write is already
 * the system of record during this phase; drift is reconciled by re-running the
 * backfill. Enable a hard-fail policy only once Postgres is authoritative.
 */
export async function mirrorUserToPostgres(user: IUser): Promise<void> {
  if (process.env.AUTH_PERSISTENCE !== "postgres") {
    return;
  }
  try {
    await usersRepository.upsert({
      id: toPgId(String(user._id)),
      email: String(user.email).toLowerCase(),
      hashedPassword: user.hashedPassword ?? null,
      emailVerified: user.emailVerified ?? false,
      onboarding: (user.onboarding as never) ?? null,
    });
  } catch (error) {
    log.error("Failed to mirror user to Postgres", {
      error,
      userId: String(user._id),
    });
  }
}
