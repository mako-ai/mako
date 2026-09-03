/**
 * Test-only: attach a GitHub binding so `requireWorkspaceRepo` will write.
 *
 * Production refuses writes without a connected repo (issue #956). Suites
 * that already `initRepo` a temp APPS_GIT_ROOT still need a Workspace
 * `workspaceRepos[]` row — local git alone is not a skip.
 */
import { Types } from "mongoose";
import { Workspace } from "../database/workspace-schema";

export async function bindTestWorkspaceRepo(
  workspaceId: string,
): Promise<void> {
  const id = new Types.ObjectId(workspaceId);
  await Workspace.findOneAndUpdate(
    { _id: id },
    {
      $setOnInsert: {
        name: "test-ws",
        slug: `test-${workspaceId}`,
        createdBy: "test",
        settings: {},
        billing: {},
      },
      $set: {
        workspaceRepos: [
          {
            provider: "github",
            owner: "test-owner",
            repo: "test-repo",
            defaultBranch: "main",
            subdirectory: "",
            linkedBy: "test",
            linkedAt: new Date(),
          },
        ],
      },
    },
    { upsert: true },
  );
}

export async function unbindTestWorkspaceRepo(
  workspaceId: string,
): Promise<void> {
  await Workspace.updateOne(
    { _id: new Types.ObjectId(workspaceId) },
    { $unset: { workspaceRepos: "", appsRepo: "" } },
  );
}
