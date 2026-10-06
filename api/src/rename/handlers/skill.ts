import { RenameError, type RenameHandler } from "../types";

// STUB — replaced by the skill workstream.
export const skillRenameHandler: RenameHandler = {
  kind: "skill",
  describe: "skill: not implemented yet.",
  async resolve() {
    return null;
  },
  async rename() {
    throw new RenameError("Renaming a skill is not supported yet.", 400);
  },
};
