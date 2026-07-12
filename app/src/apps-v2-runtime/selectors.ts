import type { AppV2ConversationBranch } from "../store/appV2Store";

const EMPTY_CONVERSATION_BRANCHES: AppV2ConversationBranch[] = [];

export function selectAppV2ConversationBranches(
  state: {
    conversationBranchesByProject: Record<
      string,
      AppV2ConversationBranch[] | undefined
    >;
  },
  projectId: string,
): AppV2ConversationBranch[] {
  return (
    state.conversationBranchesByProject[projectId] ??
    EMPTY_CONVERSATION_BRANCHES
  );
}
