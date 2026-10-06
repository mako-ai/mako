import { RenameError, type RenameHandler } from "../types";

// STUB — replaced by the dbt_job workstream.
export const dbtJobRenameHandler: RenameHandler = {
  kind: "dbt_job",
  describe: "dbt_job: not implemented yet.",
  async resolve() {
    return null;
  },
  async rename() {
    throw new RenameError("Renaming a dbt_job is not supported yet.", 400);
  },
};
