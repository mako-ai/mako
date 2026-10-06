import { RenameError, type RenameHandler } from "../types";

// STUB — replaced by the connection workstream.
export const connectionRenameHandler: RenameHandler = {
  kind: "connection",
  describe: "connection: not implemented yet.",
  async resolve() {
    return null;
  },
  async rename() {
    throw new RenameError("Renaming a connection is not supported yet.", 400);
  },
};
