/**
 * Turn-level `.makorules` resolution for the chat agents.
 *
 * A chat turn knows at most which dbt project the user has open (forwarded from
 * the active tab). This resolves that hint — or a workspace with exactly one
 * dbt project — into a rendered rules block. Multi-project workspaces with no
 * open dbt tab get nothing here; the agent still receives the rules inline from
 * `read_dbt_project_tree`, which the dbt workflow makes it call first.
 */

import { Types } from "mongoose";
import { DbtProject, type IDbtProject } from "../database/workspace-schema";
import { renderDbtRulesBlock, resolveDbtRules } from "./dbt-rules.service";

async function resolveProject(
  workspaceId: string,
  dbtProjectId?: string,
): Promise<IDbtProject | null> {
  const workspaceFilter = { workspaceId: new Types.ObjectId(workspaceId) };

  if (dbtProjectId) {
    // A bad id from a stale client must not fail the turn.
    if (!Types.ObjectId.isValid(dbtProjectId)) return null;
    return DbtProject.findOne({
      ...workspaceFilter,
      _id: new Types.ObjectId(dbtProjectId),
    });
  }

  // No hint: unambiguous only when the workspace has exactly one project.
  const projects = await DbtProject.find(workspaceFilter).limit(2);
  return projects.length === 1 ? projects[0] : null;
}

export async function resolveDbtRulesBlockForTurn(params: {
  workspaceId: string;
  userId?: string;
  dbtProjectId?: string;
}): Promise<string> {
  const project = await resolveProject(params.workspaceId, params.dbtProjectId);
  if (!project) return "";

  const rules = await resolveDbtRules(project, params.userId);
  if (!rules) return "";

  return renderDbtRulesBlock(rules, project.name);
}
