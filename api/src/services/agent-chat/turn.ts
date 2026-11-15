/**
 * The resolved state of one chat turn, shared by every generation segment
 * (the request-driven one and any "no client attached" continuations).
 * Built once by `handleChatTurn`; read-only afterwards except for the
 * `appsTouchedPaths` set, which the apps tools fill as they write.
 */
import type { LanguageModel } from "ai";

import type { buildProviderOptions } from "../../agent-lib/ai-gateway";
import type { getModelById } from "../../agent-lib/ai-models";
import type { ScreenshotVisionAttachment } from "../agent-stream.service";
import type { ChatAgentRuntime } from "./agent-runtime";
import type { TurnAbortScope } from "./turn-abort";

export interface ChatTurn extends ChatAgentRuntime {
  chatId: string;
  workspaceId: string;
  actorId: string;
  actorEmail: string | undefined;
  agentId: string;
  modelId: string;
  model: LanguageModel;
  modelDef: Awaited<ReturnType<typeof getModelById>>;
  modelSupportsVision: boolean | undefined;
  providerOptions: ReturnType<typeof buildProviderOptions>;
  abort: TurnAbortScope;
  /** Repo-relative `apps/<slug>` roots this turn's apps tools wrote to. */
  appsTouchedPaths: Set<string>;
  screenshotVisionAttachments: ScreenshotVisionAttachment[] | undefined;
}

export const MAX_STEPS = 256;
