import { eq, lt } from "drizzle-orm";

import { getDb } from "../client";
import { NewSessionRow, SessionRow, UserRow, sessions, users } from "../schema";

/**
 * Typed CRUD for the `sessions` table — the Postgres session store that backs
 * the cookie-based auth (`auth/session.ts`).
 */
export const sessionsRepository = {
  async create(input: NewSessionRow): Promise<SessionRow> {
    const [row] = await getDb().insert(sessions).values(input).returning();
    return row;
  },

  async findById(id: string): Promise<SessionRow | null> {
    const rows = await getDb()
      .select()
      .from(sessions)
      .where(eq(sessions.id, id));
    return rows[0] ?? null;
  },

  /** Joined session + user lookup, mirroring session validation needs. */
  async findWithUser(
    id: string,
  ): Promise<{ session: SessionRow; user: UserRow } | null> {
    const rows = await getDb()
      .select({ session: sessions, user: users })
      .from(sessions)
      .innerJoin(users, eq(sessions.userId, users.id))
      .where(eq(sessions.id, id));
    return rows[0] ?? null;
  },

  async updateExpiry(id: string, expiresAt: Date): Promise<void> {
    await getDb()
      .update(sessions)
      .set({ expiresAt })
      .where(eq(sessions.id, id));
  },

  async setActiveWorkspace(
    id: string,
    activeWorkspaceId: string | null,
  ): Promise<void> {
    await getDb()
      .update(sessions)
      .set({ activeWorkspaceId })
      .where(eq(sessions.id, id));
  },

  async delete(id: string): Promise<void> {
    await getDb().delete(sessions).where(eq(sessions.id, id));
  },

  async deleteAllForUser(userId: string): Promise<void> {
    await getDb().delete(sessions).where(eq(sessions.userId, userId));
  },

  /** TTL replacement: prune expired sessions (the Mongo TTL index analog). */
  async deleteExpired(now: Date = new Date()): Promise<number> {
    const result = await getDb()
      .delete(sessions)
      .where(lt(sessions.expiresAt, now))
      .returning({ id: sessions.id });
    return result.length;
  },

  async upsert(input: NewSessionRow): Promise<SessionRow> {
    const [row] = await getDb()
      .insert(sessions)
      .values(input)
      .onConflictDoUpdate({
        target: sessions.id,
        set: {
          userId: input.userId,
          expiresAt: input.expiresAt,
          activeWorkspaceId: input.activeWorkspaceId ?? null,
        },
      })
      .returning();
    return row;
  },
};
