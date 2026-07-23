/**
 * Codex model helpers for ChatGPT-subscription / local ACP sessions.
 *
 * Current ChatGPT Codex defaults are the GPT-5.6 Sol/Terra/Luna family
 * (see https://developers.openai.com/codex/models). Older adapters that
 * lack metadata for those ids surface "Model metadata … not found" /
 * opaque "Internal error" — upgrade Codex CLI + codex-acp rather than
 * treating Sol as unsupported.
 */

import type { AcpModelChoice } from "./session-config";

/** Shown when the adapter has not yet advertised a model list. */
export const CODEX_CHATGPT_MODEL_FALLBACKS: AcpModelChoice[] = [
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

/**
 * Synthetic / foreign gateway ids that should never be applied as a Codex
 * session model (Mako/Cursor catalog bleed). Real Codex ids — including
 * gpt-5.6-sol — are allowed.
 */
export function isForeignGatewayCodexModel(model: string): boolean {
  const m = model.trim().toLowerCase();
  if (!m) return false;
  if (m.startsWith("openai/")) return true;
  if (m.includes("cursor") || m.includes("mako")) return true;
  return false;
}

/** @deprecated Use isForeignGatewayCodexModel — Sol/Terra/Luna are valid. */
export function isUnsupportedCodexChatGptModel(model: string): boolean {
  return isForeignGatewayCodexModel(model);
}

/**
 * Prefer an explicit Chat pick, else keep current unless it is a foreign
 * gateway slug, else first advertised / fallback ChatGPT Codex model.
 * Returns null when the session should keep its current model.
 */
export function pickSafeCodexModel(
  preferred: string | null | undefined,
  available: AcpModelChoice[] | undefined,
  current: string | null | undefined,
): string | null {
  const choices = available?.length
    ? available
    : CODEX_CHATGPT_MODEL_FALLBACKS.filter(c => c.value !== "default");

  const usable = choices.filter(
    c => c.value !== "default" && !isForeignGatewayCodexModel(c.value),
  );

  const preferredTrim = preferred?.trim();
  if (preferredTrim && !isForeignGatewayCodexModel(preferredTrim)) {
    return preferredTrim;
  }

  if (current && !isForeignGatewayCodexModel(current)) {
    return null; // keep current (including gpt-5.6-sol)
  }

  const sol = usable.find(c => /gpt-5\.6-sol/i.test(c.value));
  if (sol) return sol.value;
  const codexNamed = usable.find(c => /codex/i.test(c.value));
  if (codexNamed) return codexNamed.value;
  if (usable[0]) return usable[0].value;
  return "gpt-5.6-sol";
}

export function explainCodexModelFailure(message: string): string | null {
  const text = message || "";
  if (/model metadata|not found/i.test(text)) {
    return (
      "Codex could not load model metadata (often an outdated Codex CLI or " +
      "ACP adapter). Mako will try to update them on this machine automatically " +
      "— send your message again. GPT-5.6 Sol/Terra/Luna are the current models."
    );
  }
  if (/internal error/i.test(text)) {
    return (
      "Codex ACP returned Internal error. Mako will try to update Codex CLI + " +
      "ACP adapter on this machine — send again after it finishes. If it keeps " +
      "failing, restart Local Agent and re-Enable workspace tools."
    );
  }
  return null;
}
