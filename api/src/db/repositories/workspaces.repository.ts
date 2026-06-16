import { and, eq } from "drizzle-orm";

import { getDb } from "../client";
import {
  NewWorkspaceMemberRow,
  NewWorkspaceRow,
  WorkspaceMemberRow,
  WorkspaceRow,
  workspaceMembers,
  workspaces,
} from "../schema";

/**
 * Typed CRUD for `workspaces` and `workspace_members` (tenancy domain).
 */
export const workspacesRepository = {
  async findById(id: string): Promise<WorkspaceRow | null> {
    const rows = await getDb()
      .select()
      .from(workspaces)
      .where(eq(workspaces.id, id));
    return rows[0] ?? null;
  },

  async findBySlug(slug: string): Promise<WorkspaceRow | null> {
    const rows = await getDb()
      .select()
      .from(workspaces)
      .where(eq(workspaces.slug, slug.toLowerCase()));
    return rows[0] ?? null;
  },

  async create(input: NewWorkspaceRow): Promise<WorkspaceRow> {
    const [row] = await getDb()
      .insert(workspaces)
      .values({ ...input, slug: input.slug.toLowerCase() })
      .returning();
    return row;
  },

  async upsert(input: NewWorkspaceRow): Promise<WorkspaceRow> {
    const [row] = await getDb()
      .insert(workspaces)
      .values({ ...input, slug: input.slug.toLowerCase() })
      .onConflictDoUpdate({
        target: workspaces.id,
        set: {
          name: input.name,
          slug: input.slug.toLowerCase(),
          settings: input.settings ?? null,
          billing: input.billing ?? null,
          selfDirective: input.selfDirective ?? "",
          updatedAt: new Date(),
        },
      })
      .returning();
    return row;
  },

  async update(
    id: string,
    patch: Partial<NewWorkspaceRow>,
  ): Promise<WorkspaceRow | null> {
    const [row] = await getDb()
      .update(workspaces)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(workspaces.id, id))
      .returning();
    return row ?? null;
  },

  async delete(id: string): Promise<void> {
    await getDb().delete(workspaces).where(eq(workspaces.id, id));
  },

  async listForUser(userId: string): Promise<WorkspaceRow[]> {
    return getDb()
      .select({
        id: workspaces.id,
        name: workspaces.name,
        slug: workspaces.slug,
        createdBy: workspaces.createdBy,
        settings: workspaces.settings,
        billing: workspaces.billing,
        selfDirective: workspaces.selfDirective,
        createdAt: workspaces.createdAt,
        updatedAt: workspaces.updatedAt,
      })
      .from(workspaces)
      .innerJoin(
        workspaceMembers,
        eq(workspaceMembers.workspaceId, workspaces.id),
      )
      .where(eq(workspaceMembers.userId, userId));
  },

  // ---- members ----

  async addMember(input: NewWorkspaceMemberRow): Promise<WorkspaceMemberRow> {
    const [row] = await getDb()
      .insert(workspaceMembers)
      .values(input)
      .onConflictDoUpdate({
        target: [workspaceMembers.workspaceId, workspaceMembers.userId],
        set: { role: input.role },
      })
      .returning();
    return row;
  },

  async getMember(
    workspaceId: string,
    userId: string,
  ): Promise<WorkspaceMemberRow | null> {
    const rows = await getDb()
      .select()
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, workspaceId),
          eq(workspaceMembers.userId, userId),
        ),
      );
    return rows[0] ?? null;
  },

  async hasAccess(workspaceId: string, userId: string): Promise<boolean> {
    return (await this.getMember(workspaceId, userId)) !== null;
  },
};
