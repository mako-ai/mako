import { eq, sql } from "drizzle-orm";

import { getDb } from "../client";
import { NewUserRow, UserRow, users } from "../schema";

/**
 * Typed CRUD for the `users` table. This is the Postgres equivalent of the
 * `User` Mongoose model and the read/write surface used by `AuthService`.
 */
export const usersRepository = {
  async findById(id: string): Promise<UserRow | null> {
    const rows = await getDb().select().from(users).where(eq(users.id, id));
    return rows[0] ?? null;
  },

  async findByEmail(email: string): Promise<UserRow | null> {
    const rows = await getDb()
      .select()
      .from(users)
      .where(eq(sql`lower(${users.email})`, email.toLowerCase()));
    return rows[0] ?? null;
  },

  async create(input: NewUserRow): Promise<UserRow> {
    const [row] = await getDb()
      .insert(users)
      .values({ ...input, email: input.email.toLowerCase() })
      .returning();
    return row;
  },

  /** Insert preserving an explicit id (used by the backfill). */
  async upsert(input: NewUserRow): Promise<UserRow> {
    const [row] = await getDb()
      .insert(users)
      .values({ ...input, email: input.email.toLowerCase() })
      .onConflictDoUpdate({
        target: users.id,
        set: {
          email: input.email.toLowerCase(),
          hashedPassword: input.hashedPassword ?? null,
          emailVerified: input.emailVerified ?? false,
          onboarding: input.onboarding ?? null,
          updatedAt: new Date(),
        },
      })
      .returning();
    return row;
  },

  async update(
    id: string,
    patch: Partial<NewUserRow>,
  ): Promise<UserRow | null> {
    const [row] = await getDb()
      .update(users)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(users.id, id))
      .returning();
    return row ?? null;
  },

  async delete(id: string): Promise<void> {
    await getDb().delete(users).where(eq(users.id, id));
  },
};
