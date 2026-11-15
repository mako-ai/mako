/**
 * Request/response schemas and serializers shared by the workspace
 * sub-routers (mounted together at /api/workspaces by ../workspaces.ts).
 */
import { z } from "@hono/zod-openapi";
import { jsonBody, zDateTime, zObjectId } from "../../openapi/core";

const MemberRole = z.enum(["admin", "member", "viewer"]);
/**
 * A workspace name is a LABEL, not a document. Unbounded free text pasted
 * at onboarding (entire app prompts, SQL queries) poisoned every list that
 * renders names — the super-admin flags page became unreadable. Collapse
 * whitespace/control characters to single spaces, trim, and cap the length;
 * the frontend mirrors the same limit.
 */
export const WORKSPACE_NAME_MAX = 80;
const workspaceNameControlChars = new RegExp(
  "[" + String.fromCharCode(0) + "-" + String.fromCharCode(31) + "\u007f]+",
  "g",
);
const WorkspaceName = z
  .string()
  .transform(value =>
    value.replace(workspaceNameControlChars, " ").replace(/\s+/g, " ").trim(),
  )
  .pipe(
    z
      .string()
      .min(1, "Workspace name is required")
      .max(
        WORKSPACE_NAME_MAX,
        `Workspace name must be at most ${WORKSPACE_NAME_MAX} characters`,
      ),
  );
export const CreateWorkspaceBody = jsonBody(
  z.object({ name: WorkspaceName, slug: z.string().optional() }),
);
export const UpdateWorkspaceBody = jsonBody(
  z.object({
    name: WorkspaceName.optional(),
    settings: z.record(z.string(), z.any()).optional(),
  }),
  true,
);
export const AddMemberBody = jsonBody(
  z.object({ userId: z.string(), role: MemberRole }),
);
export const UpdateMemberRoleBody = jsonBody(z.object({ role: MemberRole }));
export const AutoJoinBody = jsonBody(
  z.object({
    domains: z.array(z.string()).max(20),
    role: z.enum(["member", "viewer"]).default("viewer"),
  }),
);
export const LinkPreviewsBody = jsonBody(z.object({ enabled: z.boolean() }));
export const CreateInviteBody = jsonBody(
  z.object({ email: z.string(), role: MemberRole }),
);
export const AcpPlanDecisionBody = jsonBody(
  z.object({
    agentSessionId: z.string().uuid(),
    decision: z.enum(["approve", "request_changes", "cancel"]),
    planMarkdown: z.string().max(100_000).optional(),
    grants: z
      .array(
        z.enum([
          "artifact-write",
          "warehouse-write",
          "git-write",
          "schedule-write",
          "workflows-run",
        ]),
      )
      .optional(),
  }),
);

export const WorkspaceSchema = z
  .object({
    id: zObjectId(),
    name: z.string(),
    slug: z.string(),
    role: z.string().optional(),
    createdAt: zDateTime(),
    updatedAt: zDateTime(),
    settings: z.record(z.string(), z.any()),
  })
  .openapi("Workspace");

export const IdParam = z.object({
  id: z.string().openapi({ param: { name: "id", in: "path" } }),
});
export const TokenParam = z.object({
  token: z.string().openapi({ param: { name: "token", in: "path" } }),
});
export const IdUserParam = IdParam.extend({
  userId: z.string().openapi({ param: { name: "userId", in: "path" } }),
});
export const IdInviteParam = IdParam.extend({
  inviteId: z.string().openapi({ param: { name: "inviteId", in: "path" } }),
});
export const IdKeyParam = IdParam.extend({
  keyId: z.string().openapi({ param: { name: "keyId", in: "path" } }),
});
export const JsonBody = {
  required: false,
  content: {
    "application/json": { schema: z.record(z.string(), z.any()) },
  },
};

type WorkspaceMemberResponseSource = {
  _id: unknown;
  userId?: unknown;
  role: string;
  joinedAt: unknown;
};

export function serializeWorkspaceMember(
  member: WorkspaceMemberResponseSource,
) {
  const populatedUser =
    member.userId && typeof member.userId === "object"
      ? (member.userId as { _id?: unknown; email?: unknown })
      : null;

  return {
    id: member._id,
    userId: populatedUser?._id ?? member.userId,
    email: typeof populatedUser?.email === "string" ? populatedUser.email : "",
    role: member.role,
    joinedAt: member.joinedAt,
  };
}
