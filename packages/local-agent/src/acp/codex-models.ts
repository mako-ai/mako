/**
 * Codex ChatGPT-subscription model hygiene.
 *
 * API/gateway "sol" tier ids (e.g. gpt-5.6-sol) show up in some Codex
 * configs / catalogs but fail with ChatGPT login — surfacing as vague
 * "Internal error" + "Model metadata … not found" in Chat.
 */

import type { AcpModelChoice } from "./session-config";

/** Safe ChatGPT-subscription defaults when the adapter advertises nothing. */
export const CODEX_CHATGPT_MODEL_FALLBACKS: AcpModelChoice[] = [
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

/**
 * Models that typically fail under ChatGPT-subscription Codex (API/gateway
 * catalogs, Cursor/Mako gateway slugs, provider-prefixed gateway ids).
 */
export function isUnsupportedCodexChatGptModel(model: string): boolean {
  const m = model.trim().toLowerCase();
  if (!m) return false;
  if (m.includes("-sol")) return true;
  if (m.startsWith("openai/")) return true;
  if (m.includes("cursor") || m.includes("mako")) return true;
  // Bare gateway-style slugs without "codex" often aren't ChatGPT Codex models.
  if (/^gpt-5(\.\d+)?-sol/.test(m)) return true;
  return false;
}

export function pickSafeCodexModel(
  preferred: string | null | undefined,
  available: AcpModelChoice[] | undefined,
  current: string | null | undefined,
): string | null {
  const choices = available?.length
    ? available
    : CODEX_CHATGPT_MODEL_FALLBACKS.filter(c => c.value !== "default");

  const usable = choices.filter(
    c => c.value !== "default" && !isUnsupportedCodexChatGptModel(c.value),
  );

  const preferredTrim = preferred?.trim();
  if (
    preferredTrim &&
    !isUnsupportedCodexChatGptModel(preferredTrim) &&
    (usable.length === 0 ||
      usable.some(
        c => c.value.toLowerCase() === preferredTrim.toLowerCase(),
      ))
  ) {
    return preferredTrim;
  }

  if (current && !isUnsupportedCodexChatGptModel(current)) {
    return null; // keep current
  }

  // Prefer an advertised *codex* model, then first usable, then hardcoded.
  const codexNamed = usable.find(c => /codex/i.test(c.value));
  if (codexNamed) return codexNamed.value;
  if (usable[0]) return usable[0].value;
  return "gpt-5.1-codex";
}

export function explainCodexModelFailure(message: string): string | null {
  const text = message || "";
  if (
    /gpt-5\.?\d*-sol|model metadata|not supported when using Codex with a ChatGPT/i.test(
      text,
    ) ||
    (/internal error/i.test(text) && /-sol/i.test(text))
  ) {
    return (
      "Codex is trying to use an API/gateway model (e.g. gpt-5.6-sol) that " +
      "ChatGPT-subscription Codex does not support. In Chat, pick " +
      "**Codex · GPT-5.1 Codex (local)** (or another non-sol model), or in " +
      "Terminal run `codex` and switch to a ChatGPT Codex model. Also upgrade: " +
      "`npm i -g @agentclientprotocol/codex-acp` and update the Codex CLI."
    );
  }
  if (/internal error/i.test(text)) {
    return (
      "Codex ACP returned Internal error. Common fixes: upgrade " +
      "`npm i -g @agentclientprotocol/codex-acp`, update Codex CLI (`codex --version`), " +
      "and ensure ~/.codex/config.toml `model` is a ChatGPT Codex model " +
      "(not gpt-*-sol / openai/* gateway ids)."
    );
  }
  return null;
}
