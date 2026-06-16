import { and, desc, eq } from "drizzle-orm";

import { getDb } from "../client";
import { NewSavedConsoleRow, SavedConsoleRow, savedConsoles } from "../schema";

/**
 * Typed CRUD for `saved_consoles` (the consoles domain). The list view omits
 * the heavy `description_embedding`/`code` columns to match the lightweight
 * list pattern used by the Mongo `consoles` route.
 */
export const consolesRepository = {
  async findById(id: string): Promise<SavedConsoleRow | null> {
    const rows = await getDb()
      .select()
      .from(savedConsoles)
      .where(eq(savedConsoles.id, id));
    return rows[0] ?? null;
  },

  async listForWorkspace(workspaceId: string) {
    return getDb()
      .select({
        id: savedConsoles.id,
        workspaceId: savedConsoles.workspaceId,
        folderId: savedConsoles.folderId,
        connectionId: savedConsoles.connectionId,
        name: savedConsoles.name,
        description: savedConsoles.description,
        language: savedConsoles.language,
        access: savedConsoles.access,
        isDeleted: savedConsoles.isDeleted,
        executionCount: savedConsoles.executionCount,
        createdBy: savedConsoles.createdBy,
        createdAt: savedConsoles.createdAt,
        updatedAt: savedConsoles.updatedAt,
      })
      .from(savedConsoles)
      .where(
        and(
          eq(savedConsoles.workspaceId, workspaceId),
          eq(savedConsoles.isDeleted, false),
        ),
      )
      .orderBy(desc(savedConsoles.updatedAt));
  },

  async create(input: NewSavedConsoleRow): Promise<SavedConsoleRow> {
    const [row] = await getDb().insert(savedConsoles).values(input).returning();
    return row;
  },

  async upsert(input: NewSavedConsoleRow): Promise<SavedConsoleRow> {
    const [row] = await getDb()
      .insert(savedConsoles)
      .values(input)
      .onConflictDoUpdate({
        target: savedConsoles.id,
        set: {
          name: input.name,
          description: input.description ?? null,
          code: input.code ?? null,
          language: input.language ?? null,
          folderId: input.folderId ?? null,
          connectionId: input.connectionId ?? null,
          access: input.access ?? null,
          isDeleted: input.isDeleted ?? false,
          updatedAt: new Date(),
        },
      })
      .returning();
    return row;
  },

  async update(
    id: string,
    patch: Partial<NewSavedConsoleRow>,
  ): Promise<SavedConsoleRow | null> {
    const [row] = await getDb()
      .update(savedConsoles)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(savedConsoles.id, id))
      .returning();
    return row ?? null;
  },

  /** Soft delete (mirrors the Mongo `is_deleted` convention). */
  async softDelete(id: string): Promise<void> {
    await getDb()
      .update(savedConsoles)
      .set({ isDeleted: true, deletedAt: new Date(), updatedAt: new Date() })
      .where(eq(savedConsoles.id, id));
  },

  async delete(id: string): Promise<void> {
    await getDb().delete(savedConsoles).where(eq(savedConsoles.id, id));
  },
};
