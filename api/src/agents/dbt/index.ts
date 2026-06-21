/**
 * Standalone dbt agent.
 *
 * Auto-detected for dbt-file / dbt-job tabs (production chat resolves to the
 * unified agent, which carries the same tools via the `dbt` expertise mode —
 * this standalone agent exists for direct `agentId: "dbt"` calls and API
 * consumers).
 */

import type {
  AgentConfig,
  AgentContext,
  AgentFactory,
  AgentMeta,
} from "../types";
import { clientDbtTools } from "@mako/agent-tools";
import { createDbtServerTools } from "../../agent-lib/tools/dbt-tools";
import { createUniversalTools } from "../../agent-lib/tools/universal-tools";
import { createSkillTools } from "../../agent-lib/tools/skill-tools";
import { DBT_AGENT_PROMPT } from "./prompt";

export const dbtAgentMeta: AgentMeta = {
  id: "dbt",
  name: "dbt Assistant",
  description:
    "Builds and operates dbt Core projects: models, tests, jobs, and runs",
  tabKinds: ["dbt-file", "dbt-job"],
  enabled: true,
};

function buildRuntimeContext(context: AgentContext): string {
  const sections: string[] = ["\n\n---\n\n## Current State (auto-injected)\n"];

  const dbtTabs = (context.openTabs ?? []).filter(
    tab => tab.kind === "dbt-file" || tab.kind === "dbt-job",
  );
  if (dbtTabs.length > 0) {
    sections.push("### Open dbt tabs:\n");
    for (const tab of dbtTabs) {
      sections.push(
        `- [${tab.kind}] ${tab.title}${tab.isActive ? " (active)" : ""}\n`,
      );
    }
  } else {
    sections.push(
      "### Open dbt tabs:\nNone — call read_dbt_project_tree to orient.\n",
    );
  }

  if (context.databases && context.databases.length > 0) {
    sections.push("\n### Available connections:\n");
    for (const database of context.databases) {
      sections.push(
        `- ${database.name} (${database.type}) id=${database.id}\n`,
      );
    }
  }

  sections.push("\n---");
  return sections.join("");
}

export const dbtAgentFactory: AgentFactory = (
  context: AgentContext,
): AgentConfig => {
  const { workspaceId, consoles = [], consoleId, userId } = context;

  const universalTools = createUniversalTools(
    workspaceId,
    consoles,
    consoleId,
    userId,
    context.toolExecutionContext,
    { chatId: context.chatId },
  );
  const dbtServerTools = createDbtServerTools(workspaceId, userId);
  const skillTools = createSkillTools(workspaceId, userId);

  return {
    systemPrompt: [
      {
        role: "system" as const,
        content: DBT_AGENT_PROMPT,
        providerOptions: {
          anthropic: { cacheControl: { type: "ephemeral", ttl: "1h" } },
        },
      },
      {
        role: "system" as const,
        content:
          (context.skillsBlock ?? "") +
          (context.workspaceCustomPrompt
            ? `\n\n## Workspace instructions\n${context.workspaceCustomPrompt}`
            : "") +
          buildRuntimeContext(context),
      },
    ],
    tools: {
      ...universalTools,
      ...clientDbtTools,
      ...dbtServerTools,
      ...skillTools,
    },
  };
};
