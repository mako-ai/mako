/**
 * Params and helpers shared by the source-connection routers
 * (../source-connections.ts and its sub-routers here).
 */
import { z } from "@hono/zod-openapi";
import { AuthenticatedContext } from "../../middleware/workspace.middleware";
import { Types } from "mongoose";
import { peopleOf, type Caller } from "../../access/source-connection-access";

export const WorkspaceParam = z.object({
  workspaceId: z
    .string()
    .openapi({ param: { name: "workspaceId", in: "path" } }),
});
export const SourceIdParam = WorkspaceParam.extend({
  id: z.string().openapi({ param: { name: "id", in: "path" } }),
});

/**
 * Deep links are `/cx/:id` with `[a-zA-Z0-9-]+`, so values like `undefined`
 * and `new` are legal URLs. Asking mongoose to cast those is a 500
 * CastError (`Cast to ObjectId failed for value "undefined"`). Refuse them
 * here instead — same bar as `GET /databases/:id`.
 */
export function isSourceConnectionId(id: string | undefined): id is string {
  return typeof id === "string" && Types.ObjectId.isValid(id);
}

export function asSourceRecord(doc: unknown): Record<string, unknown> {
  return (doc ?? {}) as Record<string, unknown>;
}
export const OpenBody = {
  required: false,
  content: {
    "application/json": { schema: z.record(z.string(), z.any()) },
  },
};

/** Who is asking: whether they may change a connection is part of its answer. */
export async function callerOf(
  c: AuthenticatedContext,
  workspaceId: string,
): Promise<Caller> {
  const userId = (c.get("user") as { id?: string } | undefined)?.id;
  const people = peopleOf(workspaceId);
  return {
    ...people,
    role: userId ? await people.roleOf(userId) : null,
    userId,
  };
}
