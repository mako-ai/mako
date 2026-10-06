/**
 * `skill` — `skills/<name>/SKILL.md` in the workspace repo; the folder name
 * is the identity. A rename moves the folder and records the old name as
 * `aliases:` in the front matter, one commit on main (skills.service
 * `renameSkill`, shared with the Skills panel).
 *
 * IDS. A skill's id is derived from its name (`skillId`), and nothing
 * durable stores one: no Mongo row, no telemetry, no chat record keys on
 * it (audited 2026-10: only the admin routes and tool results carry it,
 * transiently). So the id follows the name — and an id minted from an OLD
 * name still resolves (`findSkillById` walks aliases), which is what an
 * open Skills panel or a transcript needs.
 *
 * PERMISSION. The skills routes let any workspace member save, rename and
 * delete (membership is checked by the objects route / MCP auth); the
 * agent's `save_skill` acts for the key's user or as "agent". Same here.
 */
import { RenameError, type RenameHandler } from "../types";
import { renameSkill, resolveSkillRef } from "../../services/skills.service";
import {
  findSkillById,
  resolveSkillRefThroughHistory,
} from "../../apps/workspace-skills.service";

const SKILLS_URL = "/settings/skills";

export const skillRenameHandler: RenameHandler = {
  kind: "skill",
  describe:
    "skill: `ref` is the skill's name, an old name, or its id; `slug` (or `title` — a skill has one name) = the new snake_case name. Moves skills/<old>/ to skills/<new>/ and records the old name in the front matter `aliases`, one commit on main; load_skill and links keep resolving the old name.",
  async resolve(ctx, ref) {
    const byId = await findSkillById(ctx.workspaceId, ref);
    const hit = byId
      ? {
          skill: byId,
          via: byId.id === ref ? ("current" as const) : ("alias" as const),
        }
      : ((await resolveSkillRef(ctx.workspaceId, ref)) ??
        (await resolveSkillRefThroughHistory(ctx.workspaceId, ref)));
    if (!hit) return null;
    return {
      kind: "skill",
      id: hit.skill.id,
      via: hit.via,
      current: {
        title: hit.skill.name,
        slug: hit.skill.name,
        path: hit.skill.path,
        url: SKILLS_URL,
      },
    };
  },
  async rename(ctx, request) {
    const to = request.slug ?? request.title;
    if (!to) throw new RenameError("Give the new skill name as slug.", 400);
    if (request.slug && request.title && request.slug !== request.title) {
      throw new RenameError(
        "A skill has one name: give it as slug (title must match or be omitted).",
        400,
      );
    }
    const result = await renameSkill(
      ctx.workspaceId,
      request.ref,
      to,
      ctx.userId,
    );
    if (!result.success) throw new RenameError(result.error, result.status);
    return {
      kind: "skill",
      id: result.skill.id,
      before: {
        title: result.before.name,
        slug: result.before.name,
        path: `skills/${result.before.name}/SKILL.md`,
        url: SKILLS_URL,
      },
      after: {
        title: result.skill.name,
        slug: result.skill.name,
        path: `skills/${result.skill.name}/SKILL.md`,
        url: SKILLS_URL,
      },
      aliasesAdded: result.aliasesAdded,
      commit: result.commit,
      warnings:
        result.skill.id === result.before.id
          ? []
          : [
              `The skill's id changed from ${result.before.id} to ${result.skill.id} (ids derive from the name); the old id still resolves.`,
            ],
    };
  },
};
