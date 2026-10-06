import { RenameError, type RenameHandler } from "../types";

// STUB — replaced by the console workstream.
export const consoleRenameHandler: RenameHandler = {
  kind: "console",
  describe: "console: not implemented yet.",
  async resolve() {
    return null;
  },
  async rename() {
    throw new RenameError("Renaming a console is not supported yet.", 400);
  },
};
