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

/**
 * Shown when the adapter has not yet advertised a model list.
 * Terra first: ChatGPT subscriptions reject `gpt-5.6-sol`
 * ("not supported when using Codex with a ChatGPT account").
 */
export const CODEX_CHATGPT_MODEL_FALLBACKS: AcpModelChoice[] = [
  {
    value: "default",
    name: "Default",
    description: "Codex’s current default for this login",
  },
  { value: "gpt-5.6-terra", name: "GPT-5.6 Terra" },
  { value: "gpt-5.6-luna", name: "GPT-5.6 Luna" },
  { value: "gpt-5.6-sol", name: "GPT-5.6 Sol" },
  { value: "gpt-5.6", name: "GPT-5.6" },
  { value: "gpt-5.5", name: "GPT-5.5" },
  { value: "gpt-5.4", name: "GPT-5.4" },
  { value: "gpt-5.4-mini", name: "GPT-5.4 Mini" },
  { value: "gpt-5.3-codex", name: "GPT-5.3 Codex" },
  { value: "gpt-5.3-codex-spark", name: "GPT-5.3 Codex Spark" },
];

/** Models ChatGPT Codex often rejects even when the adapter advertises them. */
export function isChatGptRejectedCodexModel(model: string): boolean {
  return /gpt-5\.6-sol/i.test(model.trim());
}

/** True when Codex rejected the model for a ChatGPT (non–API-key) login. */
export function isCodexChatGptModelRejectedError(message: string): boolean {
  return /not supported when using Codex with a ChatGPT account/i.test(
    message || "",
  );
}

/** Prefer Terra / Luna / 5.5 when Sol (or another rejected id) is current. */
export function pickChatGptCompatibleCodexModel(
  available: AcpModelChoice[] | undefined,
  avoid?: string | null,
): string {
  const choices = available?.length
    ? available
    : CODEX_CHATGPT_MODEL_FALLBACKS.filter(c => c.value !== "default");
  const usable = choices.filter(
    c =>
      c.value !== "default" &&
      !isForeignGatewayCodexModel(c.value) &&
      !isChatGptRejectedCodexModel(c.value) &&
      c.value.toLowerCase() !== (avoid || "").toLowerCase(),
  );
  const terra = usable.find(c => /gpt-5\.6-terra/i.test(c.value));
  if (terra) return terra.value;
  const luna = usable.find(c => /gpt-5\.6-luna/i.test(c.value));
  if (luna) return luna.value;
  if (usable[0]) return usable[0].value;
  return "gpt-5.6-terra";
}

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
  // ChatGPT subscriptions reject Sol even when the user picks it in Chat —
  // remap immediately so Enable / set_config don't surface raw API errors.
  if (preferredTrim && isChatGptRejectedCodexModel(preferredTrim)) {
    return pickChatGptCompatibleCodexModel(choices, preferredTrim);
  }
  if (preferredTrim && !isForeignGatewayCodexModel(preferredTrim)) {
    return preferredTrim;
  }

  // Adapter often defaults to Sol; ChatGPT accounts reject it. Switch to Terra.
  if (current && isChatGptRejectedCodexModel(current)) {
    return pickChatGptCompatibleCodexModel(choices, current);
  }

  if (current && !isForeignGatewayCodexModel(current)) {
    return null; // keep current
  }

  return pickChatGptCompatibleCodexModel(choices, current);
}

export function explainCodexModelFailure(message: string): string | null {
  const text = message || "";
  if (isCodexChatGptModelRejectedError(text)) {
    return (
      "That Codex model is not available on a ChatGPT subscription (often " +
      "GPT-5.6 Sol). Pick Codex · GPT-5.6 Terra (or Luna / GPT-5.5) in the " +
      "Chat model dropdown, then send again."
    );
  }
  if (/CODEX_API_KEY|OPENAI_API_KEY/i.test(text)) {
    return (
      "Codex is not signed in. Click Sign in with ChatGPT (runs `codex login`), " +
      "complete ChatGPT auth in Terminal, then retry. " +
      "Alternatively set OPENAI_API_KEY / CODEX_API_KEY in the environment " +
      "before starting Mako Desktop."
    );
  }
  if (/model metadata|not found/i.test(text)) {
    return (
      "Codex could not load model metadata (often an outdated Codex CLI or " +
      "ACP adapter). Mako will try to update them on this machine automatically " +
      "— send your message again. Prefer GPT-5.6 Terra on ChatGPT logins."
    );
  }
  if (/internal error/i.test(text)) {
    return (
      "Codex ACP returned Internal error. Usually ChatGPT login is missing " +
      "(`codex login`) or Codex CLI is outdated — Sign in with ChatGPT, " +
      "Update Codex, then retry."
    );
  }
  return null;
}
