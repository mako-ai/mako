import { Session, User, ISession, IUser } from "../database/schema";
import {
  isObjectIdDerivedUuid,
  toPgId,
  toPgIdOrNull,
  uuidToObjectId,
} from "../db/ids";
import { sessionsRepository } from "../db/repositories";
import { loggers } from "../logging";

const log = loggers.auth();

/**
 * Repository seam for the auth/session domain. The session store is the only
 * place that touches the persistence layer for sessions + the user lookup that
 * session validation needs, so it can be swapped from Mongo to Postgres with a
 * single flag (`AUTH_PERSISTENCE=postgres`) — the proven first vertical slice
 * of the Mongo -> Postgres migration.
 *
 * `activeWorkspaceId` is always exchanged in the **app representation** (a Mongo
 * ObjectId hex string). The Postgres store converts to/from its `uuid` column
 * using the reversible id mapping, so downstream code that still resolves
 * workspaces from Mongo keeps working during the gradual migration.
 */
export interface StoredSession {
  id: string;
  userId: string;
  expiresAt: Date;
  activeWorkspaceId?: string;
}

export interface StoredUser {
  id: string;
  email: string;
}

export interface SessionStore {
  readonly backend: "mongo" | "postgres";
  create(input: {
    id: string;
    userId: string;
    expiresAt: Date;
    activeWorkspaceId?: string;
  }): Promise<void>;
  findWithUser(id: string): Promise<{
    session: StoredSession | null;
    user: StoredUser | null;
  }>;
  updateExpiry(id: string, expiresAt: Date): Promise<void>;
  setActiveWorkspace(
    id: string,
    activeWorkspaceId: string | undefined,
  ): Promise<void>;
  setActiveWorkspaceForUser(
    userId: string,
    activeWorkspaceId: string | undefined,
  ): Promise<number>;
  delete(id: string): Promise<void>;
  deleteAllForUser(userId: string): Promise<void>;
  deleteExpired(now?: Date): Promise<number>;
}

class MongoSessionStore implements SessionStore {
  readonly backend = "mongo" as const;

  async create(input: {
    id: string;
    userId: string;
    expiresAt: Date;
    activeWorkspaceId?: string;
  }): Promise<void> {
    await Session.create({
      _id: input.id,
      userId: input.userId,
      expiresAt: input.expiresAt,
      activeWorkspaceId: input.activeWorkspaceId,
    });
  }

  async findWithUser(id: string): Promise<{
    session: StoredSession | null;
    user: StoredUser | null;
  }> {
    const sessionDoc = await Session.findById(id).lean<ISession>();
    if (!sessionDoc) {
      return { session: null, user: null };
    }
    const session: StoredSession = {
      id: sessionDoc._id,
      userId: sessionDoc.userId,
      expiresAt: sessionDoc.expiresAt,
      activeWorkspaceId: sessionDoc.activeWorkspaceId,
    };
    const userDoc = await User.findById(sessionDoc.userId).lean<IUser>();
    if (!userDoc) {
      return { session, user: null };
    }
    return { session, user: { id: userDoc._id, email: userDoc.email } };
  }

  async updateExpiry(id: string, expiresAt: Date): Promise<void> {
    await Session.updateOne({ _id: id }, { expiresAt });
  }

  async setActiveWorkspace(
    id: string,
    activeWorkspaceId: string | undefined,
  ): Promise<void> {
    await Session.updateOne({ _id: id }, { activeWorkspaceId });
  }

  async setActiveWorkspaceForUser(
    userId: string,
    activeWorkspaceId: string | undefined,
  ): Promise<number> {
    const result = await Session.updateMany({ userId }, { activeWorkspaceId });
    return result.modifiedCount ?? 0;
  }

  async delete(id: string): Promise<void> {
    await Session.deleteOne({ _id: id });
  }

  async deleteAllForUser(userId: string): Promise<void> {
    await Session.deleteMany({ userId });
  }

  async deleteExpired(now: Date = new Date()): Promise<number> {
    const result = await Session.deleteMany({ expiresAt: { $lte: now } });
    return result.deletedCount ?? 0;
  }
}

/** Map a stored `uuid` workspace id back to its Mongo hex representation. */
function workspaceUuidToHex(
  value: string | null | undefined,
): string | undefined {
  if (!value) {
    return undefined;
  }
  return isObjectIdDerivedUuid(value) ? uuidToObjectId(value) : value;
}

async function legacyUserIdForPgUser(user: StoredUser): Promise<string> {
  const mongoUser = await User.findOne({ email: user.email })
    .select({ _id: 1 })
    .lean<Pick<IUser, "_id">>();
  return mongoUser?._id ?? user.id;
}

class PostgresSessionStore implements SessionStore {
  readonly backend = "postgres" as const;

  async create(input: {
    id: string;
    userId: string;
    expiresAt: Date;
    activeWorkspaceId?: string;
  }): Promise<void> {
    await sessionsRepository.create({
      id: input.id,
      userId: toPgId(input.userId),
      expiresAt: input.expiresAt,
      activeWorkspaceId: toPgIdOrNull(input.activeWorkspaceId),
    });
  }

  async findWithUser(id: string): Promise<{
    session: StoredSession | null;
    user: StoredUser | null;
  }> {
    const row = await sessionsRepository.findWithUser(id);
    if (!row) {
      // Session may exist without a (backfilled) user; surface that distinctly.
      const sessionOnly = await sessionsRepository.findById(id);
      if (!sessionOnly) {
        return { session: null, user: null };
      }
      return {
        session: {
          id: sessionOnly.id,
          userId: sessionOnly.userId,
          expiresAt: sessionOnly.expiresAt,
          activeWorkspaceId: workspaceUuidToHex(sessionOnly.activeWorkspaceId),
        },
        user: null,
      };
    }
    const legacyUserId = await legacyUserIdForPgUser(row.user);
    return {
      session: {
        id: row.session.id,
        userId: legacyUserId,
        expiresAt: row.session.expiresAt,
        activeWorkspaceId: workspaceUuidToHex(row.session.activeWorkspaceId),
      },
      user: { id: legacyUserId, email: row.user.email },
    };
  }

  async updateExpiry(id: string, expiresAt: Date): Promise<void> {
    await sessionsRepository.updateExpiry(id, expiresAt);
  }

  async setActiveWorkspace(
    id: string,
    activeWorkspaceId: string | undefined,
  ): Promise<void> {
    await sessionsRepository.setActiveWorkspace(
      id,
      toPgIdOrNull(activeWorkspaceId),
    );
  }

  async setActiveWorkspaceForUser(
    userId: string,
    activeWorkspaceId: string | undefined,
  ): Promise<number> {
    return sessionsRepository.setActiveWorkspaceForUser(
      toPgId(userId),
      toPgIdOrNull(activeWorkspaceId),
    );
  }

  async delete(id: string): Promise<void> {
    await sessionsRepository.delete(id);
  }

  async deleteAllForUser(userId: string): Promise<void> {
    await sessionsRepository.deleteAllForUser(toPgId(userId));
  }

  async deleteExpired(now: Date = new Date()): Promise<number> {
    return sessionsRepository.deleteExpired(now);
  }
}

let store: SessionStore | null = null;

/** Returns the active session store, selected by `AUTH_PERSISTENCE`. */
export function getSessionStore(): SessionStore {
  if (!store) {
    if (process.env.AUTH_PERSISTENCE === "postgres") {
      store = new PostgresSessionStore();
      log.info("Auth/session persistence backend: postgres");
    } else {
      store = new MongoSessionStore();
    }
  }
  return store;
}

/** Test/override hook. */
export function setSessionStore(next: SessionStore | null): void {
  store = next;
}
