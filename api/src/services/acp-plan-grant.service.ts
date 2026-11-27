import { createHash } from "node:crypto";
import type { CapabilityGrant } from "@mako/agent-tools";

import { ACP_MCP_CLIENT_ID } from "../auth/mcp-oauth.service";
import { workspaceRepo } from "../repositories/workspaces";

const PLAN_GRANT_TTL_MS = 2 * 60 * 60 * 1000;

function planDigest(planMarkdown: string): string {
  return createHash("sha256").update(planMarkdown).digest("hex");
}

export async function assertAcpAgentSessionOwner(input: {
  workspaceId: string;
  userId: string;
  agentSessionId: string;
}): Promise<void> {
  const ownsSession = await workspaceRepo.hasActiveMcpAgentSession({
    workspaceId: input.workspaceId,
    userId: input.userId,
    clientId: ACP_MCP_CLIENT_ID,
    agentSessionId: input.agentSessionId,
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
  await workspaceRepo.upsertAcpGrant({
    workspaceId: input.workspaceId,
    userId: input.userId,
    agentSessionId: input.agentSessionId,
    planDigest: planDigest(input.planMarkdown),
    grants,
    expiresAt,
  });
  return { grants, expiresAt };
}

export async function revokeAcpPlanGrant(input: {
  workspaceId: string;
  userId: string;
  agentSessionId: string;
}): Promise<void> {
  await assertAcpAgentSessionOwner(input);
  await workspaceRepo.revokeAcpGrant({
    workspaceId: input.workspaceId,
    userId: input.userId,
    agentSessionId: input.agentSessionId,
  });
}

export async function resolveAcpPlanGrants(input: {
  workspaceId: string;
  userId: string;
  agentSessionId?: string;
}): Promise<CapabilityGrant[]> {
  if (!input.agentSessionId) {
    return [];
  }
  const grant = await workspaceRepo.findActiveAcpGrant({
    workspaceId: input.workspaceId,
    userId: input.userId,
    agentSessionId: input.agentSessionId,
  });
  return (grant?.grants ?? []) as CapabilityGrant[];
}
