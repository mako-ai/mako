/**
 * Client-only synthetic model ids for Local Agent ACP providers.
 * These never go through /api/agent/chat or the AI Gateway.
 *
 * Id shapes:
 * - `local-acp/claude` — Claude Code with adapter default model
 * - `local-acp/claude/fable` — Claude Code forced to Fable (alias or full id)
 * - `local-acp/codex` / `local-acp/codex/<model>` — same for Codex
 */
import type { AIModel } from "./api-types";
import type {
  AcpModelChoice,
  AcpProviderId,
  AcpProviderStatus,
} from "./acp-types";

export const LOCAL_ACP_MODEL_PREFIX = "local-acp/";

export const LOCAL_ACP_CLAUDE_MODEL_ID = `${LOCAL_ACP_MODEL_PREFIX}claude`;
export const LOCAL_ACP_CODEX_MODEL_ID = `${LOCAL_ACP_MODEL_PREFIX}codex`;

/** Shown in Chat before a session reports adapter model lists. */
export const CLAUDE_CODE_MODEL_FALLBACKS: AcpModelChoice[] = [
  {
    value: "default",
    name: "Default",
    description: "Claude Code’s current default",
  },
  { value: "sonnet", name: "Sonnet" },
  { value: "opus", name: "Opus" },
  { value: "fable", name: "Fable" },
  { value: "haiku", name: "Haiku" },
];

/** ChatGPT-subscription Codex models (avoid API/gateway `*-sol` ids). */
export const CODEX_MODEL_FALLBACKS: AcpModelChoice[] = [
  {
    value: "default",
    name: "Default",
    description: "Codex’s current default for this login",
  },
  { value: "gpt-5.1-codex", name: "GPT-5.1 Codex" },
  { value: "gpt-5.1-codex-mini", name: "GPT-5.1 Codex Mini" },
  { value: "o3", name: "o3" },
  { value: "o4-mini", name: "o4-mini" },
];

/** Filter out API/gateway models that break ChatGPT-login Codex. */
export function isUnsupportedCodexChatGptModel(model: string): boolean {
  const m = model.trim().toLowerCase();
  if (!m) return false;
  return (
    m.includes("-sol") ||
    m.startsWith("openai/") ||
    m.includes("cursor") ||
    m.includes("mako")
  );
}

const PROVIDER_LABEL: Record<AcpProviderId, string> = {
  claude: "Claude Code",
  codex: "Codex",
};

const PROVIDER_BASE: Record<
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
  if (!isLocalAcpModelId(modelId)) return null;
  const rest = modelId.slice(LOCAL_ACP_MODEL_PREFIX.length);
  const provider = rest.split("/")[0];
  if (provider === "claude" || provider === "codex") return provider;
  return null;
}

/**
 * Model preference for `session/set_config_option`.
 * `null` means leave the adapter default alone.
 */
export function localAcpModelPreference(
  modelId: string | null | undefined,
): string | null {
  if (!modelId || !isLocalAcpModelId(modelId)) return null;
  const rest = modelId.slice(LOCAL_ACP_MODEL_PREFIX.length);
  const slash = rest.indexOf("/");
  if (slash < 0) return null;
  const value = rest.slice(slash + 1).trim();
  if (!value || value === "default") return null;
  return value;
}

export function buildLocalAcpModelId(
  providerId: AcpProviderId,
  modelValue?: string | null,
): string {
  const base = `${LOCAL_ACP_MODEL_PREFIX}${providerId}`;
  const value = modelValue?.trim();
  if (!value || value === "default") return base;
  return `${base}/${value}`;
}

function mergeModelChoices(
  advertised: AcpModelChoice[] | undefined,
  fallbacks: AcpModelChoice[],
): AcpModelChoice[] {
  const byValue = new Map<string, AcpModelChoice>();
  for (const choice of fallbacks) {
    byValue.set(choice.value.toLowerCase(), choice);
  }
  for (const choice of advertised ?? []) {
    const key = choice.value.toLowerCase();
    byValue.set(key, choice);
    // Drop short-alias fallbacks when a full id for the same family exists.
    for (const alias of ["sonnet", "opus", "fable", "haiku"]) {
      if (key.includes(alias) && key !== alias) {
        byValue.delete(alias);
      }
    }
  }
  // Keep Default first, then stable alphabetical by name.
  const list = [...byValue.values()];
  list.sort((a, b) => {
    if (a.value === "default") return -1;
    if (b.value === "default") return 1;
    return a.name.localeCompare(b.name);
  });
  return list;
}

const LOCAL_ACP_PROVIDER_IDS = Object.keys(PROVIDER_BASE) as AcpProviderId[];

/**
 * Expand Claude Code / Codex into per-model Chat picker rows under
 * "On this machine", so Desktop can switch Sonnet → Fable without Terminal.
 */
export function localAcpModelsFromProviders(
  providers: AcpProviderStatus[] | undefined | null,
): AIModel[] {
  const byId = new Map((providers ?? []).map(p => [p.id, p]));
  const out: AIModel[] = [];

  for (const providerId of LOCAL_ACP_PROVIDER_IDS) {
    const def = PROVIDER_BASE[providerId];
    const status = byId.get(providerId);
    const label = PROVIDER_LABEL[providerId];

    if (!providers) {
      out.push({
        ...def,
        description: `${def.description} — start Local Agent to use`,
      });
      continue;
    }

    if (status && !status.adapterFound) {
      out.push({
        ...def,
        description: `${def.description} — adapter missing (${status.installHint})`,
      });
      continue;
    }

    const fallbacks =
      providerId === "claude"
        ? CLAUDE_CODE_MODEL_FALLBACKS
        : CODEX_MODEL_FALLBACKS;
    const advertised =
      providerId === "codex"
        ? (status?.availableModels ?? []).filter(
            m => !isUnsupportedCodexChatGptModel(m.value),
          )
        : status?.availableModels;
    const choices = mergeModelChoices(advertised, fallbacks);

    for (const choice of choices) {
      const id = buildLocalAcpModelId(providerId, choice.value);
      const isDefault = choice.value === "default";
      out.push({
        id,
        name: isDefault
          ? `${label} (local)`
          : `${label} · ${choice.name} (local)`,
        provider: "local",
        description: isDefault
          ? def.description
          : `${def.description} — model: ${choice.name}`,
        tier: "free",
        supportsTools: true,
      });
    }
  }

  return out;
}
