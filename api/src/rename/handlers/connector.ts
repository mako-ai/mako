import { RenameError, type RenameHandler } from "../types";

// STUB — replaced by the connector workstream.
export const connectorRenameHandler: RenameHandler = {
  kind: "connector",
  describe: "connector: not implemented yet.",
  async resolve() {
    return null;
  },
  async rename() {
    throw new RenameError("Renaming a connector is not supported yet.", 400);
  },
};
