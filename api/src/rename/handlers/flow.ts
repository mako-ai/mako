import { RenameError, type RenameHandler } from "../types";

// STUB — replaced by the flow workstream.
export const flowRenameHandler: RenameHandler = {
  kind: "flow",
  describe: "flow: not implemented yet.",
  async resolve() {
    return null;
  },
  async rename() {
    throw new RenameError("Renaming a flow is not supported yet.", 400);
  },
};
