/**
 * Step 2 of a chat turn: which model runs it. Resolved before anything else
 * is loaded so the billing check runs against the model actually used; the
 * language model itself is built once the agent runtime exists.
 */
import { getModel } from "../../agent-lib/ai-gateway";
import {
  getAvailableModels,
  getDefaultFreeModelId,
  getDefaultModelId,
} from "../../agent-lib/ai-models";
import { withContextOverflowSelfHeal } from "../../agent-lib/context-overflow-self-heal";
import { withThinkingSelfHeal } from "../../agent-lib/thinking-self-heal";
import { getEffectiveBillingPlan } from "../../billing/config";
import { checkBillingLimits } from "../../billing/usage-limit.middleware";
import { workspaceRepo } from "../../repositories/workspaces";

export type ChatModelSelection =
  | { ok: true; resolvedModelId: string }
  | {
      ok: false;
      /** The billing check's own `{ code, message, … }` body (UpgradePrompt reads it). */
      body: Awaited<ReturnType<typeof checkBillingLimits>>["error"];
      status: 402 | 403;
    };

/**
 * The requested model when the workspace may use it, else the plan-aware
 * default; then the billing check (model access + usage quota).
 */
export async function selectChatModel(
  workspaceId: string,
  requestedModelId: string | undefined,
): Promise<ChatModelSelection> {
  const ws = await workspaceRepo.findById(workspaceId);
  const effectivePlan = getEffectiveBillingPlan(ws?.billing);
  const available = await getAvailableModels(
    ws?.settings?.disabledModelIds ?? [],
  );
  const isModelAllowed = available.some(m => m.id === requestedModelId);
  const resolvedModelId =
    requestedModelId && isModelAllowed
      ? requestedModelId
      : effectivePlan === "free"
        ? await getDefaultFreeModelId()
        : await getDefaultModelId();

  const billingCheck = await checkBillingLimits(workspaceId, resolvedModelId);
  if (!billingCheck.allowed) {
    return {
      ok: false,
      body: billingCheck.error,
      status: billingCheck.statusCode || 402,
    };
  }
  return { ok: true, resolvedModelId };
}

/**
 * The language model with its self-heal wrappers:
 * - thinking: if the catalog still classifies an Anthropic model as manual
 *   thinking but the provider rejects it with the adaptive-only 400, persist
 *   the corrected mode and retry transparently;
 * - context overflow (provider-agnostic backstop): if the prompt still
 *   overflows the window (estimate too optimistic, or contextWindow
 *   unknown), retry once with aggressively trimmed history instead of
 *   surfacing a raw 400.
 */
export function buildChatLanguageModel(resolvedModelId: string) {
  const baseModel = resolvedModelId.startsWith("anthropic/")
    ? withThinkingSelfHeal(getModel(resolvedModelId), resolvedModelId)
    : getModel(resolvedModelId);
  return withContextOverflowSelfHeal(baseModel, resolvedModelId);
}
