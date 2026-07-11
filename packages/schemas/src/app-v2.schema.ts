import { z } from "zod";

export const AppV2AccessSchema = z.enum(["private", "workspace"]);
export type AppV2Access = z.infer<typeof AppV2AccessSchema>;

export const AppV2WorkspaceRoleSchema = z.enum(["viewer", "editor"]);
export type AppV2WorkspaceRole = z.infer<typeof AppV2WorkspaceRoleSchema>;

export const AppV2ProjectCreateSchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2_000).optional(),
  access: AppV2AccessSchema.default("private"),
  workspaceRole: AppV2WorkspaceRoleSchema.default("viewer"),
});
export type AppV2ProjectCreate = z.infer<typeof AppV2ProjectCreateSchema>;

export const AppV2MutationStateSchema = z.object({
  ifRevision: z.number().int().nonnegative(),
  expectedWipOid: z.string().regex(/^[0-9a-f]{40}$/),
  leaseEpoch: z.number().int().nonnegative(),
});
export type AppV2MutationState = z.infer<typeof AppV2MutationStateSchema>;

export const AppV2MaxPathCharacters = 1_024;
export const AppV2MaxFileContentCharacters = 1_048_576;

export const AppV2WriteFileSchema = AppV2MutationStateSchema.extend({
  path: z.string().min(1).max(AppV2MaxPathCharacters),
  content: z.string().max(AppV2MaxFileContentCharacters),
  executable: z.boolean().default(false),
});

export const AppV2DeleteFileSchema = AppV2MutationStateSchema.extend({
  path: z.string().min(1).max(AppV2MaxPathCharacters),
});

export const AppV2MoveFileSchema = AppV2MutationStateSchema.extend({
  from: z.string().min(1).max(AppV2MaxPathCharacters),
  to: z.string().min(1).max(AppV2MaxPathCharacters),
});

export const AppV2CommitSchema = AppV2MutationStateSchema.extend({
  message: z.string().trim().min(1).max(2_000),
});

export const AppV2DiscardSchema = AppV2MutationStateSchema;
export const AppV2LeaseRotateSchema = AppV2MutationStateSchema;
