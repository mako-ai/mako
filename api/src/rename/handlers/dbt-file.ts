import { RenameError, type RenameHandler } from "../types";

// STUB — replaced by the dbt_file workstream.
export const dbtFileRenameHandler: RenameHandler = {
  kind: "dbt_file",
  describe: "dbt_file: not implemented yet.",
  async resolve() {
    return null;
  },
  async rename() {
    throw new RenameError("Renaming a dbt_file is not supported yet.", 400);
  },
};
