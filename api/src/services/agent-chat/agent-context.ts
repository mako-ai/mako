/**
 * Step 4 of a chat turn: everything the agent is told about the workspace
 * and this turn — custom prompt, databases, open consoles, auto-discovered
 * consoles, skills, dbt rules, MCP tools and the Apps checkout branch.
 *
 * Every optional enrichment is best-effort: a failure is logged and the turn
 * runs without it.
 */
import { Types } from "mongoose";

import type { AgentContext } from "../../agents";
import type { ConsoleDataV2 } from "../../agent-lib/types";
import { searchConsoles } from "../../agent-lib/tools/console-search-tools";
import {
  readWorkspacePromptFile,
  readWorkspaceSelfDirectiveFile,
} from "../../apps/workspace-prompt";
import { AppWorktree } from "../../database/workspace-schema";
import { connectionsRepo } from "../../repositories/connections";
import { isDbtShapedTurn } from "../../dbt/dbt-turn-shape";
import { loggers } from "../../logging";
import { prepareAgentTurnGuidance } from "../agent-turn-preparation.service";
import { buildMcpToolsForChat } from "../mcp-client.service";
import type { OpenConsoleContext, OpenTabContext } from "./request";

const logger = loggers.agent();

/** Agents that get console hints and turn guidance (skills / dbt rules). */
function isConsoleCapableAgent(agentId: string): boolean {
  return agentId === "console" || agentId === "unified";
}

export interface WorkspaceTurnContext {
  workspaceCustomPrompt: string;
  selfDirective: string;
  databases: NonNullable<AgentContext["databases"]>;
  consoles: ConsoleDataV2[];
}

/** Custom prompt, self-directive, databases and the open consoles. */
export async function loadWorkspaceTurnContext(
  workspaceId: string,
  openConsoles: OpenConsoleContext[] | undefined,
): Promise<WorkspaceTurnContext> {
  let workspaceCustomPrompt = "";
  let selfDirective = "";
  try {
    workspaceCustomPrompt = (await readWorkspacePromptFile(workspaceId)) ?? "";
    selfDirective = (await readWorkspaceSelfDirectiveFile(workspaceId)) ?? "";
  } catch (err) {
    logger.warn("Failed to load workspace custom prompt", { error: err });
  }

  const workspaceDatabases =
    await connectionsRepo.listDatabaseConnectionMetadata(workspaceId);

  const databaseTypeMap = new Map<string, string>();
  workspaceDatabases.forEach(db => {
    databaseTypeMap.set(db.id, db.type);
  });

  // Open consoles in the tools' ConsoleDataV2 shape, with the connection
  // type filled in from the workspace's databases when the client omitted it.
  const consoles: ConsoleDataV2[] = (openConsoles || []).map(oc => ({
    id: oc.id,
    title: oc.title,
    content: oc.content,
    connectionId: oc.connectionId,
    databaseId: oc.databaseId,
    databaseName: oc.databaseName,
    connectionType:
      oc.connectionType ||
      (oc.connectionId ? databaseTypeMap.get(oc.connectionId) : undefined),
  }));

  return {
    workspaceCustomPrompt,
    selfDirective,
    databases: workspaceDatabases.map(db => ({
      id: db.id,
      name: db.name,
      type: db.type,
      sqlDialect: undefined,
    })),
    consoles,
  };
}

/**
 * Auto-discover relevant consoles. `searchConsoles` prefers vector search
 * but falls back to MongoDB $text and regex-name search, so it runs
 * regardless of whether Atlas vector search / embeddings are available —
 * otherwise self-hosted / local Mongo deployments would get zero hints and
 * the agent would recreate consoles it could have found by name.
 */
async function discoverConsoleHints(
  agentId: string,
  workspaceId: string,
  lastUserText: string,
  messageCount: number,
): Promise<string> {
  if (!isConsoleCapableAgent(agentId) || messageCount === 0) return "";
  try {
    if (lastUserText.length < 5) return "";
    const hints = await searchConsoles(lastUserText, workspaceId, 3);
    if (hints.length === 0) return "";
    return (
      "\n\n---\n\n### Relevant Saved Consoles (auto-discovered)\n" +
      hints
        .map(
          h =>
            `- "${h.title}" — ${h.description || "no description"} (id: ${h.id}${h.connectionName ? `, connection: ${h.connectionName}` : ""}, ${h.language})${h.isSaved ? " [saved]" : ""}`,
        )
        .join("\n") +
      "\nUse search_consoles for more, or open_console to load one into the editor."
    );
  } catch (err) {
    logger.debug("Console hint injection skipped", { error: err });
    return "";
  }
}

/** Skills block and (for dbt-shaped turns) the project's dbt rules. */
async function prepareGuidance(input: {
  agentId: string;
  workspaceId: string;
  actorId: string;
  lastUserText: string;
  openTabs: OpenTabContext[] | undefined;
  tabKind: string | undefined;
}): Promise<{ skillsBlock: string; dbtRulesBlock: string }> {
  const none = { skillsBlock: "", dbtRulesBlock: "" };
  if (!isConsoleCapableAgent(input.agentId)) return none;
  try {
    const { openTabs, tabKind } = input;
    const includeDbtRules = isDbtShapedTurn({ openTabs, tabKind });
    const dbtTabs = (openTabs ?? []).filter(t => t.dbtProjectId);
    const activeDbtProjectId = dbtTabs.find(t => t.isActive)?.dbtProjectId;
    const distinctProjectIds = new Set(dbtTabs.map(t => t.dbtProjectId));
    const dbtProjectId =
      activeDbtProjectId ??
      (distinctProjectIds.size === 1 ? dbtTabs[0]?.dbtProjectId : undefined);
    const guidance = await prepareAgentTurnGuidance({
      workspaceId: input.workspaceId,
      userId: input.actorId,
      userText: input.lastUserText,
      includeDbtRules,
      dbtProjectId,
    });
    return {
      skillsBlock: guidance.skillsBlock,
      dbtRulesBlock: guidance.dbtRulesBlock,
    };
  } catch (err) {
    logger.warn("Turn guidance injection skipped", { error: err });
    return none;
  }
}

type McpChatTools = Awaited<ReturnType<typeof buildMcpToolsForChat>>;

/**
 * MCP tools (Close CRM etc.) for the unified agent: built from DB-cached tool
 * definitions, so this never blocks on remote MCP servers. Executions
 * connect on demand.
 */
async function loadMcpChatTools(
  agentId: string,
  workspaceId: string,
  actorId: string,
  chatId: string,
): Promise<McpChatTools> {
  const empty: McpChatTools = {
    tools: {},
    readOnlyToolNames: [],
    allToolNames: [],
    catalog: [],
  };
  if (agentId !== "unified") return empty;
  try {
    const mcp = await buildMcpToolsForChat({ workspaceId, userId: actorId });
    if (mcp.allToolNames.length > 0) {
      logger.info("MCP tools loaded for chat", {
        workspaceId,
        chatId,
        toolCount: mcp.allToolNames.length,
      });
    }
    return mcp;
  } catch (err) {
    logger.warn("MCP tool loading skipped", { error: err });
    return empty;
  }
}

export interface TurnGuidance {
  consoleHints: string;
  skillsBlock: string;
  dbtRulesBlock: string;
  mcp: McpChatTools;
  appsBranch: string | undefined;
}

/**
 * The per-turn enrichments, in the order the route has always loaded them:
 * console hints, guidance, MCP tools, Apps checkout branch.
 */
export async function gatherTurnGuidance(input: {
  agentId: string;
  workspaceId: string;
  actorId: string;
  chatId: string;
  lastUserText: string;
  messageCount: number;
  openTabs: OpenTabContext[] | undefined;
  tabKind: string | undefined;
}): Promise<TurnGuidance> {
  const consoleHints = await discoverConsoleHints(
    input.agentId,
    input.workspaceId,
    input.lastUserText,
    input.messageCount,
  );
  const { skillsBlock, dbtRulesBlock } = await prepareGuidance(input);
  const mcp = await loadMcpChatTools(
    input.agentId,
    input.workspaceId,
    input.actorId,
    input.chatId,
  );

  // The caller's Apps checkout branch, so the agent starts oriented instead
  // of spending a tool call on `git status`. The doc is synced by every exec
  // and checkout; a missing doc simply means "main".
  const appsWorktree = await AppWorktree.findOne(
    {
      workspaceId: new Types.ObjectId(input.workspaceId),
      userId: input.actorId,
    },
    { branch: 1 },
  )
    .lean()
    .catch(() => null);

  return {
    consoleHints,
    skillsBlock,
    dbtRulesBlock,
    mcp,
    appsBranch: appsWorktree?.branch ?? undefined,
  };
}
