import { desc, eq } from "drizzle-orm";

import { getDb } from "../client";
import { ChatRow, NewChatRow, chats } from "../schema";

/**
 * Typed CRUD for `chats`. The conversation lives in the `messages` JSONB
 * column; `save()` performs the full-thread upsert that mirrors the Mongo
 * `saveChat()` `$set` write path.
 */
export const chatsRepository = {
  async findById(id: string): Promise<ChatRow | null> {
    const rows = await getDb().select().from(chats).where(eq(chats.id, id));
    return rows[0] ?? null;
  },

  /** Lightweight list (omits the heavy `messages` blob), newest first. */
  async listForWorkspace(workspaceId: string) {
    return getDb()
      .select({
        id: chats.id,
        workspaceId: chats.workspaceId,
        title: chats.title,
        threadId: chats.threadId,
        activeAgent: chats.activeAgent,
        titleGenerated: chats.titleGenerated,
        createdBy: chats.createdBy,
        createdAt: chats.createdAt,
        updatedAt: chats.updatedAt,
      })
      .from(chats)
      .where(eq(chats.workspaceId, workspaceId))
      .orderBy(desc(chats.updatedAt));
  },

  async create(input: NewChatRow): Promise<ChatRow> {
    const [row] = await getDb().insert(chats).values(input).returning();
    return row;
  },

  /** Full-thread upsert (the Postgres analog of `saveChat`). */
  async save(input: NewChatRow): Promise<ChatRow> {
    const [row] = await getDb()
      .insert(chats)
      .values(input)
      .onConflictDoUpdate({
        target: chats.id,
        set: {
          title: input.title,
          messages: input.messages ?? [],
          activeAgent: input.activeAgent ?? null,
          pinnedConsoleId: input.pinnedConsoleId ?? null,
          activeStreamId: input.activeStreamId ?? null,
          usage: input.usage ?? null,
          titleGenerated: input.titleGenerated ?? false,
          updatedAt: new Date(),
        },
      })
      .returning();
    return row;
  },

  async update(
    id: string,
    patch: Partial<NewChatRow>,
  ): Promise<ChatRow | null> {
    const [row] = await getDb()
      .update(chats)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(chats.id, id))
      .returning();
    return row ?? null;
  },

  async delete(id: string): Promise<void> {
    await getDb().delete(chats).where(eq(chats.id, id));
  },
};
