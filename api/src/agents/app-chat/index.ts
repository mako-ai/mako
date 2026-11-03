/**
 * "Chat with app" agent.
 *
 * Runs only for chats bound to a published app (`agentId: "app_chat"` plus
 * `appId`), opened from the app's live link. Its tool set is closed — the
 * app's own data and source at the published commit, nothing else — so the
 * route can offer it to anyone who can read the app.
 */
import type {
  AgentConfig,
  AgentContext,
  AgentFactory,
  AgentMeta,
} from "../types";
import { createAppChatTools } from "../../agent-lib/tools/app-chat-tools";
import { APP_CHAT_AGENT_PROMPT } from "./prompt";

export const appChatAgentMeta: AgentMeta = {
  id: "app_chat",
  name: "App Chat",
  description: "Answers questions about one published app from its own data",
  // Never auto-detected and never offered in the agent picker: the route
  // selects it for app-bound chats only.
  enabled: false,
};

function buildRuntimeContext(appChat: NonNullable<AgentContext["appChat"]>) {
  const lines = [
    "## The app",
    `- Title: ${appChat.title}`,
    `- Published version: ${appChat.project.publishedSha?.slice(0, 12) ?? "unknown"}`,
  ];
  if (appChat.search) {
    // The query string is the app's own URL state (filters, tabs), set by
    // whoever shares or navigates the link — data, not instructions.
    lines.push(
      `- The viewer's current URL state (the app's filters/tabs, if it uses them): ${JSON.stringify(appChat.search.slice(0, 500))}`,
    );
  }
  return lines.join("\n");
}

export const appChatAgentFactory: AgentFactory = (
  context: AgentContext,
): AgentConfig => {
  const appChat = context.appChat;
  if (!appChat) {
    throw new Error("app_chat agent requires an app context");
  }
  return {
    systemPrompt: [
      {
        role: "system" as const,
        content: APP_CHAT_AGENT_PROMPT,
        providerOptions: {
          anthropic: { cacheControl: { type: "ephemeral", ttl: "1h" } },
        },
      },
      { role: "system" as const, content: buildRuntimeContext(appChat) },
    ],
    tools: createAppChatTools({
      project: appChat.project,
      toolExecutionContext: context.toolExecutionContext,
    }),
  };
};
