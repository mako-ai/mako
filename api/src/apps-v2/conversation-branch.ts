import { AppV2ValidationError } from "./errors";

const CHAT_ID_PATTERN = /^[0-9a-f]{24}$/;

export function isValidAppV2ChatId(chatId: string): boolean {
  return CHAT_ID_PATTERN.test(chatId);
}

export function appV2ConversationBranch(chatId: string): string {
  if (!isValidAppV2ChatId(chatId)) {
    throw new AppV2ValidationError("Invalid Apps v2 chat ID");
  }
  return `mako/chat/${chatId}`;
}

export function appV2GitHubConversationBranch(
  projectId: string,
  chatId: string,
): string {
  if (!CHAT_ID_PATTERN.test(projectId)) {
    throw new AppV2ValidationError("Invalid Apps v2 project ID");
  }
  if (!isValidAppV2ChatId(chatId)) {
    throw new AppV2ValidationError("Invalid Apps v2 chat ID");
  }
  return `mako/app/${projectId}/chat/${chatId}`;
}
