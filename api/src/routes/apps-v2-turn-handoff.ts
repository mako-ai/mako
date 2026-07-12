import {
  finalizeAppsV2PredecessorForHandoff,
  type AppsV2ChatTurnFinalizationResult,
} from "../apps-v2/chat-turn-finalizer";
import { getAppV2Services } from "../apps-v2/service-factory";
import {
  startAppsV2ChatTurn,
  supersedeAppsV2ChatTurn,
  type AppsV2ChatTurnIdentity,
} from "../apps-v2/chat-turn.service";
import { workspaceService } from "../services/workspace.service";
import { awaitChatFinalization } from "./chat-finalization-queue";
import {
  getAppsV2TurnOwnership,
  promoteChatTurnOwnership,
  type ChatOwnershipScope,
} from "./chat-continuation-ownership";

export const APPS_V2_FAILED_HANDOFF_POLICY =
  "block-successor-and-preserve-predecessor";

interface AppsV2TurnHandoffDependencies {
  awaitLocal(chatId: string): Promise<void>;
  readOwner(scope: ChatOwnershipScope): Promise<string | null | undefined>;
  finalizePrevious(
    identity: AppsV2ChatTurnIdentity,
  ): Promise<AppsV2ChatTurnFinalizationResult>;
  fence(identity: AppsV2ChatTurnIdentity): Promise<void>;
  start(identity: AppsV2ChatTurnIdentity): Promise<void>;
  promote(
    scope: ChatOwnershipScope,
    expectedTurnId: string | null | undefined,
    turnId: string,
  ): Promise<boolean>;
  abandon(identity: AppsV2ChatTurnIdentity): Promise<boolean>;
}

const defaultDependencies: AppsV2TurnHandoffDependencies = {
  awaitLocal: awaitChatFinalization,
  readOwner: getAppsV2TurnOwnership,
  finalizePrevious: finalizeAppsV2PredecessorForHandoff,
  async fence(identity) {
    const member = await workspaceService.getMember(
      identity.workspaceId,
      identity.actorId,
    );
    await getAppV2Services().worktrees.fenceAgentWorktreesForChat(
      identity.workspaceId,
      identity.chatId,
      { userId: identity.actorId, memberRole: member?.role },
    );
  },
  start: startAppsV2ChatTurn,
  promote: promoteChatTurnOwnership,
  abandon: supersedeAppsV2ChatTurn,
};

export interface AppsV2TurnHandoffResult {
  previousTurnId?: string;
  predecessor?: AppsV2ChatTurnFinalizationResult;
}

function isLocallyFinalizedForHandoff(
  result: AppsV2ChatTurnFinalizationResult,
): boolean {
  if (result.status !== "completed" && result.status !== "remote_failed") {
    return false;
  }
  return result.projects.every(
    project =>
      ["committed", "clean", "superseded"].includes(project.status) &&
      project.remoteStatus !== "conflict",
  );
}

/**
 * Drains same-process finalization, finalizes the durable predecessor while it
 * still owns the chat, fences every loaded Git lease, and only then promotes
 * the successor with a scoped compare-and-swap.
 */
export async function prepareAppsV2TurnHandoff(
  identity: AppsV2ChatTurnIdentity,
  dependencies: AppsV2TurnHandoffDependencies = defaultDependencies,
): Promise<AppsV2TurnHandoffResult> {
  await dependencies.awaitLocal(identity.chatId);
  const scope = {
    chatId: identity.chatId,
    workspaceId: identity.workspaceId,
    actorId: identity.actorId,
  };
  const previousTurnId = await dependencies.readOwner(scope);
  let predecessor: AppsV2ChatTurnFinalizationResult | undefined;

  if (previousTurnId && previousTurnId !== identity.turnId) {
    predecessor = await dependencies.finalizePrevious({
      ...identity,
      turnId: previousTurnId,
    });
    if (!isLocallyFinalizedForHandoff(predecessor)) {
      throw new Error(
        `${APPS_V2_FAILED_HANDOFF_POLICY}: predecessor is not locally finalized`,
      );
    }
  }

  await dependencies.fence(identity);
  await dependencies.start(identity);
  let promoted = false;
  try {
    promoted = await dependencies.promote(
      scope,
      previousTurnId,
      identity.turnId,
    );
  } catch (error) {
    await dependencies.abandon(identity);
    throw error;
  }
  if (!promoted) {
    await dependencies.abandon(identity);
    throw new Error(
      `${APPS_V2_FAILED_HANDOFF_POLICY}: ownership changed during handoff`,
    );
  }
  return {
    previousTurnId: previousTurnId ?? undefined,
    predecessor,
  };
}
