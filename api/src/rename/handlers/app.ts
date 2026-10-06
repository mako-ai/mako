import { RenameError, type RenameHandler } from "../types";

// STUB — replaced by the app workstream.
export const appRenameHandler: RenameHandler = {
  kind: "app",
  describe: "app: not implemented yet.",
  async resolve() {
    return null;
  },
  async rename() {
    throw new RenameError("Renaming a app is not supported yet.", 400);
  },
};
