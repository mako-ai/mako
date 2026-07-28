import { resolveDbtRulesBlockForTurn } from "../dbt/dbt-rules-turn.service";
import { retrieveRelevantSkills } from "./skills.service";

export const MAX_SKILL_EXCERPT_CHARS = 2_500;

export function renderCompactSkillBlock(
  retrieval: Pick<
    Awaited<ReturnType<typeof retrieveRelevantSkills>>,
    "injected"
  >,
): string {
  const skill = retrieval.injected[0];
  if (!skill?.body.trim()) return "";
  const body =
    skill.body.length <= MAX_SKILL_EXCERPT_CHARS
      ? skill.body
      : `${skill.body.slice(0, MAX_SKILL_EXCERPT_CHARS)}\n\n[Excerpt truncated. Use load_skill("${skill.name}") or read_skill_resource for the complete guide.]`;
  return [
    "\n\n---\n",
    "### Auto-loaded skill",
    `\`${skill.name}\` — ${skill.loadWhen}`,
    "",
    body,
  ].join("\n");
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
    retrieveRelevantSkills(input.workspaceId, input.userText).catch(() => null),
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
