/**
 * `skill`: `skills/<name>/SKILL.md` in the workspace repo. The folder name
 * is the identity, so a rename moves the folder and records the old name in
 * the front matter `aliases`, one commit on main (skills.service
 * `renameSkill`, which the Skills panel reaches through POST /objects).
 *
 * IDS. A skill's id is derived from its name (`skillId`) and nothing
 * durable stores one: only the admin routes and tool results carry it. So
 * the id follows the name, the result says so, and an id minted from an
 * old name still finds the skill (`findSkillById`).
 *
 * WHO. The skills routes let any workspace member save and delete a skill
 * (membership is the objects route's and the MCP credential's check), and
 * the agent's `save_skill` acts for the user; the same here. On agent
 * surfaces the kind needs the `git-write` grant (rename-capabilities.ts).
 */
import {
  findSkillById,
  resolveSkillRef,
  resolveSkillThroughHistory,
} from "../../apps/workspace-skills.service";
import { RepoRequiredError } from "../../apps/config";
import { renameSkill } from "../../services/skills.service";
import { RenameError, type RenameHandler, type RenameLocation } from "../types";

const location = (name: string): RenameLocation => ({
  title: name,
  slug: name,
  path: `skills/${name}/SKILL.md`,
  url: "/settings/skills",
});

export const skillRenameHandler: RenameHandler = {
  kind: "skill",
  describe:
    "`ref` = the skill's name, an old name of it, or its id. `slug` (or `title`: a skill has one name) = the new name: lowercase a-z, 0-9, '-' and '_', starting with a letter or digit. Moves skills/<old>/ to skills/<new>/ with every file in it and records the old name in the front matter `aliases`, one commit on main, so load_skill(\"<old>\") keeps working. Refused when the new name is another skill's name or old name.",
  async resolve(ctx, ref) {
    try {
      const byId = await findSkillById(ctx.workspaceId, ref);
      const hit = byId
        ? { skill: byId, via: byId.id === ref ? "current" : "alias" }
        : ((await resolveSkillRef(ctx.workspaceId, ref)) ??
          (await resolveSkillThroughHistory(ctx.workspaceId, ref).then(skill =>
            skill ? { skill, via: "alias" } : null,
          )));
      if (!hit) return null;
      return {
        kind: "skill",
        id: hit.skill.id,
        via: hit.via as "current" | "alias",
        current: location(hit.skill.name),
      };
    } catch (error) {
      // No connected repo: there are no skills to resolve.
      if (error instanceof RepoRequiredError) return null;
      throw error;
    }
  },
  async rename(ctx, request) {
    const to = request.slug ?? request.title;
    if (!to) throw new RenameError("Give the new skill name as slug.");
    if (request.slug && request.title && request.slug !== request.title) {
      throw new RenameError(
        "A skill has one name. Give it as slug; title, if given, must be the same.",
      );
    }
    let result: Awaited<ReturnType<typeof renameSkill>>;
    try {
      result = await renameSkill(ctx.workspaceId, request.ref, to, ctx.userId);
    } catch (error) {
      if (error instanceof RepoRequiredError) {
        throw new RenameError(error.message, 412);
      }
      throw error;
    }
    if (!result.success) throw new RenameError(result.error, result.status);
    return {
      kind: "skill",
      id: result.skill.id,
      before: location(result.before.name),
      after: location(result.skill.name),
      aliasesAdded: result.aliasesAdded,
      commit: result.commit,
      warnings:
        result.skill.id === result.before.id
          ? []
          : [
              `The skill's id changed from ${result.before.id} to ${result.skill.id}: a skill's id derives from its name. The old id still finds it.`,
            ],
    };
  },
};
