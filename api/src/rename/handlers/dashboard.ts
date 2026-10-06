import { RenameError, type RenameHandler } from "../types";

// STUB — replaced by the dashboard workstream.
export const dashboardRenameHandler: RenameHandler = {
  kind: "dashboard",
  describe: "dashboard: not implemented yet.",
  async resolve() {
    return null;
  },
  async rename() {
    throw new RenameError("Renaming a dashboard is not supported yet.", 400);
  },
};
