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

/**
 * ChatGPT Codex models when the adapter has not advertised a list yet.
 * @see https://developers.openai.com/codex/models
 */
export const CODEX_MODEL_FALLBACKS: AcpModelChoice[] = [
  {
    value: "default",
    name: "Default",
    description: "Codex’s current default for this login",
  },
  { value: "gpt-5.6-sol", name: "GPT-5.6 Sol" },
  { value: "gpt-5.6-terra", name: "GPT-5.6 Terra" },
  { value: "gpt-5.6-luna", name: "GPT-5.6 Luna" },
  { value: "gpt-5.6", name: "GPT-5.6" },
  { value: "gpt-5.5", name: "GPT-5.5" },
  { value: "gpt-5.4", name: "GPT-5.4" },
  { value: "gpt-5.4-mini", name: "GPT-5.4 Mini" },
  { value: "gpt-5.3-codex", name: "GPT-5.3 Codex" },
  { value: "gpt-5.3-codex-spark", name: "GPT-5.3 Codex Spark" },
];

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

/**
 * Map short Chat preferences (`opus`, `sonnet`) to adapter-canonical ids
 * from the live model list. Older Claude ACP rejects bare aliases.
 */
export function resolveLocalAcpModelValue(
  preferred: string,
  available: AcpModelChoice[] | undefined | null,
): string {
  const pref = preferred.trim();
  if (!pref) return pref;
  const list = available ?? [];
  if (list.length === 0) return pref;

  const prefLower = pref.toLowerCase();
  const exact = list.find(m => m.value.toLowerCase() === prefLower);
  if (exact) return exact.value;

  const token = prefLower.replace(/[^a-z0-9]+/g, "");
  if (!token) return pref;

  let best: { value: string; score: number } | null = null;
  for (const choice of list) {
    const value = choice.value.trim();
    if (!value || value.toLowerCase() === "default") continue;
    const v = value.toLowerCase();
    const n = (choice.name || "").toLowerCase();
    let score = 0;
    if (
      v.includes(`-${token}-`) ||
      v.endsWith(`-${token}`) ||
      v.startsWith(`${token}-`)
    ) {
      score = 80;
    } else if (v.includes(token)) {
      score = 60;
    } else if (n === prefLower || n.split(/[^a-z0-9]+/).includes(token)) {
      score = 50;
    } else if (n.includes(prefLower)) {
      score = 40;
    }
    if (score === 0) continue;
    if (
      !best ||
      score > best.score ||
      (score === best.score && value.length > best.value.length)
    ) {
      best = { value, score };
    }
  }
  return best?.value ?? pref;
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
    // Show every model the adapter advertises, plus current Codex fallbacks
    // so Sol/Terra/Luna appear even before the first session caches a list.
    const choices = mergeModelChoices(status?.availableModels, fallbacks);

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
