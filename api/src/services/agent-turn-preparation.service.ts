import { resolveDbtRulesBlockForTurn } from "../dbt/dbt-rules-turn.service";
import {
  MAX_SKILL_EXCERPT_CHARS,
  renderSkillsPromptBlock,
  retrieveRelevantSkills,
} from "./skills.service";

export { MAX_SKILL_EXCERPT_CHARS };

export function renderCompactSkillBlock(
  retrieval: Pick<
    Awaited<ReturnType<typeof retrieveRelevantSkills>>,
    "index" | "injected"
  >,
): string {
  return renderSkillsPromptBlock(retrieval);
}

export interface AgentTurnGuidance {
  skillsBlock: string;
  dbtRulesBlock: string;
}

/**
 * Shared, budgeted turn preparation for native Chat and Desktop ACP.
 */
export async function prepareAgentTurnGuidance(input: {
  workspaceId: string;
  userId?: string;
  userText: string;
  includeDbtRules: boolean;
  dbtProjectId?: string;
}): Promise<AgentTurnGuidance> {
  const [retrieval, dbtRulesBlock] = await Promise.all([
    retrieveRelevantSkills(input.workspaceId).catch(() => null),
    input.includeDbtRules
      ? resolveDbtRulesBlockForTurn({
          workspaceId: input.workspaceId,
          userId: input.userId,
          dbtProjectId: input.dbtProjectId,
        }).catch(() => "")
      : Promise.resolve(""),
  ]);
  return {
    skillsBlock: retrieval ? renderCompactSkillBlock(retrieval) : "",
    dbtRulesBlock,
  };
}
