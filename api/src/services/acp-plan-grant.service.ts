import { createHash } from "node:crypto";
import type { CapabilityGrant } from "@mako/agent-tools";

import { AcpPlanGrant } from "../database/acp-plan-grant-schema";
import { McpOAuthToken } from "../database/mcp-oauth-schema";
import { ACP_MCP_CLIENT_ID } from "../auth/mcp-oauth.service";

const PLAN_GRANT_TTL_MS = 2 * 60 * 60 * 1000;

function planDigest(planMarkdown: string): string {
  return createHash("sha256").update(planMarkdown).digest("hex");
}

export async function assertAcpAgentSessionOwner(input: {
  workspaceId: string;
  userId: string;
  agentSessionId: string;
}): Promise<void> {
  const ownsSession = await McpOAuthToken.exists({
    workspaceId: input.workspaceId,
    userId: input.userId,
    clientId: ACP_MCP_CLIENT_ID,
    agentSessionId: input.agentSessionId,
    refreshExpiresAt: { $gt: new Date() },
  });
  if (!ownsSession) {
    throw new Error("ACP agent session not found");
  }
}

export async function approveAcpPlanGrant(input: {
  workspaceId: string;
  userId: string;
  agentSessionId: string;
  planMarkdown: string;
  grants: CapabilityGrant[];
}): Promise<{
  grants: CapabilityGrant[];
  expiresAt: Date;
}> {
  await assertAcpAgentSessionOwner(input);
  const expiresAt = new Date(Date.now() + PLAN_GRANT_TTL_MS);
  const grants = [...new Set(input.grants)];
  await AcpPlanGrant.findOneAndUpdate(
    { agentSessionId: input.agentSessionId },
    {
      $set: {
        workspaceId: input.workspaceId,
        userId: input.userId,
        planDigest: planDigest(input.planMarkdown),
        grants,
        status: "approved",
        expiresAt,
      },
    },
    { upsert: true, new: true },
  );
  return { grants, expiresAt };
}

export async function revokeAcpPlanGrant(input: {
  workspaceId: string;
  userId: string;
  agentSessionId: string;
}): Promise<void> {
  await assertAcpAgentSessionOwner(input);
  await AcpPlanGrant.updateOne(
    {
      workspaceId: input.workspaceId,
      userId: input.userId,
      agentSessionId: input.agentSessionId,
    },
    { $set: { status: "revoked", expiresAt: new Date() } },
  );
}

export async function resolveAcpPlanGrants(input: {
  workspaceId: string;
  userId: string;
  agentSessionId?: string;
}): Promise<CapabilityGrant[]> {
  if (!input.agentSessionId) return [];
  const grant = await AcpPlanGrant.findOne({
    workspaceId: input.workspaceId,
    userId: input.userId,
    agentSessionId: input.agentSessionId,
    status: "approved",
    expiresAt: { $gt: new Date() },
  })
    .select({ grants: 1 })
    .lean();
  return grant?.grants ?? [];
}
