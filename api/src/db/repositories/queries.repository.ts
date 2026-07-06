import { desc, eq, lt } from "drizzle-orm";

import { getDb } from "../client";
import {
  NewQueryExecutionRow,
  QueryExecutionRow,
  queryExecutions,
} from "../schema";

/**
 * Typed access for `query_executions` (append-only query audit log).
 */
export const queriesRepository = {
  async record(input: NewQueryExecutionRow): Promise<QueryExecutionRow> {
    const [row] = await getDb()
      .insert(queryExecutions)
      .values(input)
      .returning();
    return row;
  },

  async upsert(input: NewQueryExecutionRow): Promise<QueryExecutionRow> {
    const [row] = await getDb()
      .insert(queryExecutions)
      .values(input)
      .onConflictDoNothing({ target: queryExecutions.id })
      .returning();
    if (row) {
      return row;
    }
    const existing = await this.findById(String(input.id));
    if (!existing) {
      throw new Error(`query_execution upsert failed for id ${input.id}`);
    }
    return existing;
  },

  async findById(id: string): Promise<QueryExecutionRow | null> {
    const rows = await getDb()
      .select()
      .from(queryExecutions)
      .where(eq(queryExecutions.id, id));
    return rows[0] ?? null;
  },

  async listForWorkspace(
    workspaceId: string,
    limit = 100,
  ): Promise<QueryExecutionRow[]> {
    return getDb()
      .select()
      .from(queryExecutions)
      .where(eq(queryExecutions.workspaceId, workspaceId))
      .orderBy(desc(queryExecutions.executedAt))
      .limit(limit);
  },

  /** TTL replacement: prune executions older than `cutoff` (Mongo had 90d). */
  async deleteOlderThan(cutoff: Date): Promise<number> {
    const result = await getDb()
      .delete(queryExecutions)
      .where(lt(queryExecutions.executedAt, cutoff))
      .returning({ id: queryExecutions.id });
    return result.length;
  },
};
