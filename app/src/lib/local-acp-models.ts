/**
 * Client-only synthetic model ids for Local Agent ACP providers.
 * These never go through /api/agent/chat or the AI Gateway.
 */
import type { AIModel } from "./api-types";
import type { AcpProviderId, AcpProviderStatus } from "./acp-types";

export const LOCAL_ACP_MODEL_PREFIX = "local-acp/";

export const LOCAL_ACP_CLAUDE_MODEL_ID = `${LOCAL_ACP_MODEL_PREFIX}claude`;
export const LOCAL_ACP_CODEX_MODEL_ID = `${LOCAL_ACP_MODEL_PREFIX}codex`;

const LOCAL_ACP_MODEL_DEFS: Record<
  AcpProviderId,
  Omit<AIModel, "id"> & { id: string }
> = {
  claude: {
    id: LOCAL_ACP_CLAUDE_MODEL_ID,
    name: "Claude Code (local)",
    provider: "local",
    description: "Your Claude Pro/Max subscription via ACP on this machine",
    tier: "free",
    supportsTools: true,
  },
  codex: {
    id: LOCAL_ACP_CODEX_MODEL_ID,
    name: "Codex (local)",
    provider: "local",
    description: "Your ChatGPT subscription via ACP on this machine",
    tier: "free",
    supportsTools: true,
  },
};

export function isLocalAcpModelId(modelId: string | null | undefined): boolean {
  return Boolean(modelId?.startsWith(LOCAL_ACP_MODEL_PREFIX));
}

export function localAcpModelIdToProviderId(
  modelId: string,
): AcpProviderId | null {
  if (modelId === LOCAL_ACP_CLAUDE_MODEL_ID) return "claude";
  if (modelId === LOCAL_ACP_CODEX_MODEL_ID) return "codex";
  return null;
}

const LOCAL_ACP_PROVIDER_IDS = Object.keys(
  LOCAL_ACP_MODEL_DEFS,
) as AcpProviderId[];

/**
 * Always expose Claude Code + Codex in the Chat model picker under
 * "On this machine". Enrich descriptions from Local Agent ACP status when
 * available; when the agent is offline, still list them so users can select
 * their subscription-backed local sessions.
 */
export function localAcpModelsFromProviders(
  providers: AcpProviderStatus[] | undefined | null,
): AIModel[] {
  const byId = new Map((providers ?? []).map(p => [p.id, p]));
  return LOCAL_ACP_PROVIDER_IDS.map(id => {
    const def = LOCAL_ACP_MODEL_DEFS[id];
    const status = byId.get(id);
    let description = def.description;
    if (!providers) {
      description = `${def.description} — start Local Agent to use`;
    } else if (status && !status.adapterFound) {
      description = `${def.description} — adapter missing (${status.installHint})`;
    }
    return { ...def, description };
  });
}
