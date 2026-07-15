/**
 * Promote the single apps-v2 repo binding to the workspace-level
 * `workspaceRepos[]` array (repos are workspace infrastructure that apps —
 * and later consoles and dbt projects — mount into; see apps-v2.md decision
 * log 2026-07-15).
 *
 * Also converts the binding's `subdirectory` from the old "apps folder"
 * semantics (default "apps", apps directly inside) to the new "Mako root"
 * semantics ("" = repo root, apps under `<root>/apps/`): a stored value of
 * exactly "apps" was the old default, whose effective apps dir (apps/) equals
 * the new default root's — so it maps to "".
 */
import { Db } from "mongodb";
import { loggers } from "../logging";

const log = loggers.migration();

export const description =
  "Move Workspace.appsV2Repo to workspaceRepos[] (Mako-root semantics)";

export async function up(db: Db): Promise<void> {
  const workspaces = db.collection("workspaces");
  const cursor = workspaces.find({ appsV2Repo: { $exists: true } });
  let migrated = 0;
  for await (const ws of cursor) {
    const binding = ws.appsV2Repo as {
      subdirectory?: string;
      [key: string]: unknown;
    };
    const subdirectory =
      binding.subdirectory === "apps" ? "" : (binding.subdirectory ?? "");
    await workspaces.updateOne(
      { _id: ws._id },
      {
        $set: { workspaceRepos: [{ ...binding, subdirectory }] },
        $unset: { appsV2Repo: "" },
      },
    );
    migrated += 1;
  }
  log.info("Migrated apps-v2 repo bindings to workspaceRepos", { migrated });
}

export async function down(db: Db): Promise<void> {
  const workspaces = db.collection("workspaces");
  const cursor = workspaces.find({ "workspaceRepos.0": { $exists: true } });
  for await (const ws of cursor) {
    await workspaces.updateOne(
      { _id: ws._id },
      {
        $set: { appsV2Repo: (ws.workspaceRepos as unknown[])[0] },
        $unset: { workspaceRepos: "" },
      },
    );
  }
}
