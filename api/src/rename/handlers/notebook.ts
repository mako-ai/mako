import { RenameError, type RenameHandler } from "../types";

// STUB — replaced by the notebook workstream.
export const notebookRenameHandler: RenameHandler = {
  kind: "notebook",
  describe: "notebook: not implemented yet.",
  async resolve() {
    return null;
  },
  async rename() {
    throw new RenameError("Renaming a notebook is not supported yet.", 400);
  },
};
