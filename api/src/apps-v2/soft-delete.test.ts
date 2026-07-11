import assert from "node:assert/strict";
import { Types } from "mongoose";
import {
  AppV2Project,
  AppV2Worktree,
  type IAppV2Project,
  type IAppV2Worktree,
} from "../database/workspace-schema";
import { appsV2IndexesByCollection } from "../migrations/2026-07-11-201825_create_apps_v2_metadata_indexes";
import { AppV2ProjectService } from "./app-project.service";
import type { AppV2GitLease, AppV2GitProvider } from "./providers/git-provider";

const workspaceId = new Types.ObjectId();
const projectId = new Types.ObjectId();
const worktreeId = new Types.ObjectId();
const initialLeaseOid = "b".repeat(40);
const fencedLeaseOid = "c".repeat(40);
const project = {
  _id: projectId,
  workspaceId,
  repositoryId: projectId.toString(),
  owner_id: "user-1",
  access: "private",
  workspaceRole: "viewer",
  sharedWith: [],
  mutationRevision: 0,
  deletionStatus: "active",
} as unknown as IAppV2Project;
const worktree = {
  _id: worktreeId,
  workspaceId,
  projectId,
  leaseRef: `refs/mako/leases/${worktreeId.toString()}`,
  leaseOid: initialLeaseOid,
  leaseEpoch: 1,
  status: "active",
  revision: 0,
} as unknown as IAppV2Worktree;

let deletionStatus: IAppV2Project["deletionStatus"] = "active";
let currentLease: AppV2GitLease = {
  ref: worktree.leaseRef,
  oid: initialLeaseOid,
  epoch: 1,
  purpose: "active",
};
let failFence = true;
let fenceLeaseCalls = 0;
let recursiveDeleteCalls = 0;
let listFilter: unknown;

const fakeGit = {
  deleteRepository: async () => {
    recursiveDeleteCalls += 1;
  },
  getLease: async () => currentLease,
  fenceLease: async () => {
    fenceLeaseCalls += 1;
    if (failFence) throw new Error("injected transient fencing failure");
    currentLease = {
      ref: worktree.leaseRef,
      oid: fencedLeaseOid,
      epoch: 2,
      purpose: "deletion-fence",
    };
    return currentLease;
  },
} as unknown as AppV2GitProvider;
const service = new AppV2ProjectService(fakeGit);

const originalProjectFind = AppV2Project.find;
const originalProjectFindOne = AppV2Project.findOne;
const originalProjectFindOneAndUpdate = AppV2Project.findOneAndUpdate;
const originalWorktreeFind = AppV2Worktree.find;
const originalWorktreeFindOne = AppV2Worktree.findOne;
const originalWorktreeFindOneAndUpdate = AppV2Worktree.findOneAndUpdate;

AppV2Project.find = ((filter: unknown) => {
  listFilter = filter;
  return { sort: async () => [] };
}) as unknown as typeof AppV2Project.find;
AppV2Project.findOne = (async (filter: {
  deletionStatus?: string | { $in?: string[] };
}) => {
  const requested = filter.deletionStatus;
  const visible =
    typeof requested === "string"
      ? requested === deletionStatus
      : requested?.$in?.includes(deletionStatus);
  return visible ? project : null;
}) as unknown as typeof AppV2Project.findOne;
AppV2Project.findOneAndUpdate = (async (filter: {
  deletionStatus?: string;
}) => {
  if (filter.deletionStatus === "active" && deletionStatus === "active") {
    deletionStatus = "deleting";
    project.deletionStatus = "deleting";
    project.deletedBy = "user-1";
    return project;
  }
  if (filter.deletionStatus === "deleting" && deletionStatus === "deleting") {
    deletionStatus = "deleted";
    project.deletionStatus = "deleted";
    project.deletedAt = new Date();
    return project;
  }
  return null;
}) as unknown as typeof AppV2Project.findOneAndUpdate;
AppV2Worktree.find = (async () => [
  worktree,
]) as unknown as typeof AppV2Worktree.find;
AppV2Worktree.findOne = (async () =>
  worktree) as unknown as typeof AppV2Worktree.findOne;
AppV2Worktree.findOneAndUpdate = (async () => {
  worktree.leaseOid = currentLease.oid;
  worktree.leaseEpoch = currentLease.epoch;
  worktree.status = "fenced";
  worktree.revision += 1;
  return worktree;
}) as unknown as typeof AppV2Worktree.findOneAndUpdate;

async function run(): Promise<void> {
  try {
    await assert.rejects(
      service.delete(workspaceId.toString(), projectId.toString(), {
        userId: "user-1",
      }),
      /injected transient fencing failure/,
    );
    assert.equal(deletionStatus, "deleting");
    assert.equal(fenceLeaseCalls, 1);

    await assert.rejects(
      service.delete(workspaceId.toString(), projectId.toString(), {
        userId: "user-2",
      }),
      /Project not found/,
    );
    assert.equal(fenceLeaseCalls, 1);

    failFence = false;
    const deleted = await service.delete(
      workspaceId.toString(),
      projectId.toString(),
      { userId: "user-1" },
    );
    assert.equal(deleted.deletionStatus, "deleted");
    assert.equal(deletionStatus, "deleted");
    assert.equal(fenceLeaseCalls, 2);
    assert.equal(worktree.status, "fenced");
    assert.equal(recursiveDeleteCalls, 0);

    await assert.rejects(
      service.delete(workspaceId.toString(), projectId.toString(), {
        userId: "user-1",
      }),
      /Project not found/,
    );

    await service.list(workspaceId.toString(), { userId: "user-1" });
    assert.equal(
      (listFilter as { deletionStatus?: unknown }).deletionStatus,
      "active",
    );

    const deletionPath = AppV2Project.schema.path("deletionStatus");
    assert.deepEqual(deletionPath.options.enum, [
      "active",
      "deleting",
      "deleted",
    ]);
    assert(
      AppV2Project.schema
        .indexes()
        .some(([keys]) => keys.workspaceId === 1 && keys.deletionStatus === 1),
    );
    assert(
      appsV2IndexesByCollection.app_v2_projects.some(
        definition =>
          definition.keys.workspaceId === 1 &&
          definition.keys.deletionStatus === 1,
      ),
    );
  } finally {
    AppV2Project.find = originalProjectFind;
    AppV2Project.findOne = originalProjectFindOne;
    AppV2Project.findOneAndUpdate = originalProjectFindOneAndUpdate;
    AppV2Worktree.find = originalWorktreeFind;
    AppV2Worktree.findOne = originalWorktreeFindOne;
    AppV2Worktree.findOneAndUpdate = originalWorktreeFindOneAndUpdate;
  }
}

void run();
