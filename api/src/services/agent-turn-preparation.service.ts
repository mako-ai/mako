import { resolveDbtRulesBlockForTurn } from "../dbt/dbt-rules-turn.service";
import { retrieveRelevantSkills } from "./skills.service";

export const MAX_SKILL_EXCERPT_CHARS = 2_500;

export function renderCompactSkillBlock(
  retrieval: Pick<
    Awaited<ReturnType<typeof retrieveRelevantSkills>>,
    "injected"
  >,
): string {
  const pinned = retrieval.injected.filter(skill => skill.body.trim());
  if (pinned.length === 0) return "";
  const lines = ["\n\n---\n", "### Pinned skills (always loaded)"];
  for (const skill of pinned) {
    const body =
      skill.body.length <= MAX_SKILL_EXCERPT_CHARS
        ? skill.body
        : `${skill.body.slice(0, MAX_SKILL_EXCERPT_CHARS)}\n\n[Excerpt truncated. Use load_skill("${skill.name}") for the complete guide.]`;
    lines.push("", `#### \`${skill.name}\` — ${skill.loadWhen}`, "", body);
  }
  return lines.join("\n");
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
