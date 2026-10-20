/* eslint-disable no-console, no-process-exit */
/**
 * Rename personal trees `users/<userId>/` → `users/<handle>/`.
 *
 * Since personal folders are resolved through the handle mapping only
 * (user-handles.ts), a tree still named by its owner's userId is nobody's
 * until it is renamed: its apps, consoles and notebooks drop out of their
 * owner's lists. This is the migration that renames them, per workspace:
 *
 *   1. store the handles (every member, plus departed owners of a folder);
 *   2. ONE commit on main moving every `users/<userId>/…` file to
 *      `users/<handle>/…` (Mako bot author), pushed to the connected repo —
 *      unstamped apps get their id written into mako.json in the same
 *      commit, as every app move does, so no identity changes;
 *   3. rewrite the Mongo rows that store a repo path under a moved folder:
 *      app projects, the apps index (rows + folder list), saved consoles,
 *      notebook index rows.
 *
 * Dry run by default: prints the mapping, the moves, conflicts, orphans and
 * the rows it would rewrite — and writes NOTHING (no handles, no index
 * builds, no commit). `--write` applies.
 *
 * Usage (from api/):
 *   tsx src/scripts/migrate-user-folders-to-handles.ts [--workspace-id=X] [--write]
 *     every workspace with a connected repo, or one; reads the repo through
 *     Mako's own clone of it (fetched from the mirror first).
 *   tsx src/scripts/migrate-user-folders-to-handles.ts --repo=/path/to/checkout [--ref=origin/main]
 *     dry run against a local checkout's `main` (workspace id from its
 *     .mako/workspace.json). Never writes.
 *
 * Needs DATABASE_URL (+ DATABASE_NAME when the URL names no database), and
 * for --write the same git/GitHub env the API uses to push.
 */
import * as dotenv from "dotenv";
dotenv.config({ quiet: true });

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import mongoose, { Types } from "mongoose";
import {
  AppIndexEntry,
  AppIndexHead,
  AppProject,
  NotebookIndex,
  SavedConsole,
  Workspace,
} from "../database/workspace-schema";
import {
  planUserFolderRenames,
  rewriteUserPath,
  userSegments,
  type FolderRename,
  type UserFolderPlan,
} from "../apps/user-folder-migration";
import type { HandleRow } from "../apps/user-handles";

interface Args {
  workspaceId?: string;
  repo?: string;
  /** With --repo: the ref to read (default `main`; e.g. `origin/main`). */
  ref: string;
  write: boolean;
}

function parseArgs(): Args {
  const args: Args = { write: false, ref: "main" };
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith("--workspace-id=")) args.workspaceId = arg.split("=")[1];
    else if (arg.startsWith("--repo=")) args.repo = arg.slice("--repo=".length);
    else if (arg.startsWith("--ref=")) args.ref = arg.slice("--ref=".length);
    else if (arg === "--write") args.write = true;
    else if (arg === "--dry-run") args.write = false;
    else {
      console.error(`Unknown argument: ${arg}`);
      process.exit(2);
    }
  }
  if (args.repo && args.write) {
    console.error(
      "--repo is a read-only inspection of a checkout; --write migrates through Mako's own clone (omit --repo).",
    );
    process.exit(2);
  }
  return args;
}

const BOT_AUTHOR = { name: "Mako", email: "bot@mako.ai" };

/** Files at `ref` under users/, from a plain checkout. */
function checkoutFiles(repo: string, ref: string): string[] {
  const out = execFileSync(
    "git",
    ["-C", repo, "ls-tree", "-r", "--name-only", "-z", ref, "--", "users"],
    { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
  );
  return out.split("\0").filter(Boolean);
}

/** Every stored path the rename would rewrite, by collection. */
async function plannedRowRewrites(
  workspaceId: string,
  renames: FolderRename[],
): Promise<
  Array<{ collection: string; id: string; from: string; to: string }>
> {
  const ws = new Types.ObjectId(workspaceId);
  const out: Array<{
    collection: string;
    id: string;
    from: string;
    to: string;
  }> = [];
  if (renames.length === 0) return out;
  const prefix = {
    $regex: `^users/(${renames.map(r => r.userId.replace(/[^A-Za-z0-9_-]/g, "")).join("|")})(/|$)`,
  };
  const scan = async (
    collection: string,
    rows: Array<{ _id: unknown; path?: string | null }>,
  ) => {
    for (const row of rows) {
      const to = rewriteUserPath(row.path, renames);
      if (to && row.path) {
        out.push({ collection, id: String(row._id), from: row.path, to });
      }
    }
  };
  await scan(
    "appprojects",
    await AppProject.find({ workspaceId: ws, path: prefix })
      .select("_id path")
      .lean(),
  );
  await scan(
    "app_index_entries",
    await AppIndexEntry.find({ workspaceId: ws, path: prefix })
      .select("_id path")
      .lean(),
  );
  await scan(
    "savedconsoles",
    await SavedConsole.find({ workspaceId: ws, path: prefix })
      .select("_id path")
      .lean(),
  );
  await scan(
    "notebookindexes",
    await NotebookIndex.find({ workspaceId: ws, path: prefix })
      .select("_id path")
      .lean(),
  );
  const head = await AppIndexHead.findOne({ workspaceId: ws })
    .select("_id folders")
    .lean();
  for (const folder of head?.folders ?? []) {
    const to = rewriteUserPath(folder, renames);
    if (to) {
      out.push({
        collection: "app_index_heads.folders",
        id: String(head!._id),
        from: folder,
        to,
      });
    }
  }
  return out;
}

async function applyRowRewrites(
  workspaceId: string,
  renames: FolderRename[],
): Promise<number> {
  const rewrites = await plannedRowRewrites(workspaceId, renames);
  const ws = new Types.ObjectId(workspaceId);
  const models = {
    appprojects: AppProject,
    app_index_entries: AppIndexEntry,
    savedconsoles: SavedConsole,
    notebookindexes: NotebookIndex,
  } as const;
  let done = 0;
  for (const r of rewrites) {
    if (r.collection === "app_index_heads.folders") continue;
    const model = models[r.collection as keyof typeof models];
    try {
      // Only if the row still says the old path: the push-driven syncs may
      // have relocated it already, and must not be overwritten.
      const res = await (model as typeof AppProject).updateOne(
        { _id: r.id, workspaceId: ws, path: r.from },
        { $set: { path: r.to } },
      );
      done += res.modifiedCount;
    } catch (error) {
      console.warn(
        `  ! ${r.collection} ${r.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  const head = await AppIndexHead.findOne({ workspaceId: ws });
  if (head?.folders?.length) {
    const folders = head.folders.map(f => rewriteUserPath(f, renames) ?? f);
    if (folders.some((f, i) => f !== head.folders[i])) {
      await AppIndexHead.updateOne(
        { _id: head._id },
        { $set: { folders: [...new Set(folders)].sort() } },
      );
      done++;
    }
  }
  return done;
}

function printPlan(
  label: string,
  handles: { existing: HandleRow[]; assigned: HandleRow[] },
  emails: Map<string, string>,
  plan: UserFolderPlan,
): void {
  console.log(`\n=== ${label}`);
  const all = [...handles.existing, ...handles.assigned];
  console.log(
    `Handles: ${handles.existing.length} stored, ${handles.assigned.length} to assign`,
  );
  for (const h of all) {
    const tag = handles.assigned.includes(h) ? "new " : "    ";
    console.log(
      `  ${tag}${h.userId} → ${h.handle}  (${emails.get(h.userId) ?? "?"})`,
    );
  }
  console.log(`Folder renames (${plan.renames.length}):`);
  for (const r of plan.renames) {
    console.log(`  ${r.from}/ → ${r.to}/  (${r.files.length} files)`);
  }
  if (plan.alreadyHandles.length) {
    console.log(`Already named by handle: ${plan.alreadyHandles.join(", ")}`);
  }
  if (plan.orphans.length) {
    console.log(
      `Orphans (no known user; left in place, nobody's tree): ${plan.orphans.join(", ")}`,
    );
  }
  for (const c of plan.conflicts) {
    console.log(
      `CONFLICT ${c.from} → ${c.to}: ${c.files.length} target files exist (${c.files.slice(0, 3).join(", ")}…) — resolve by hand`,
    );
  }
}

async function migrateWorkspace(
  workspaceId: string,
  args: Args,
): Promise<void> {
  const { planWorkspaceHandles, ensureWorkspaceHandles } =
    await import("../apps/user-handles.service");
  let files: string[];
  let repoDir: string | null = null;
  if (args.repo) {
    files = checkoutFiles(args.repo, args.ref);
  } else {
    const { ensureLocalRepo, freshenForServe } =
      await import("../apps/cloud-repo.service");
    const { boundRepoDirIfExists } =
      await import("../apps/workspace-repo-required");
    const { listTree, resolveCommit, DEFAULT_BRANCH } =
      await import("../apps/repository.service");
    await ensureLocalRepo(workspaceId);
    await freshenForServe(workspaceId, 0).catch(() => undefined);
    repoDir = await boundRepoDirIfExists(workspaceId);
    if (!repoDir) {
      console.log(`\n=== ${workspaceId}: no repo clone, skipped`);
      return;
    }
    const sha = await resolveCommit(repoDir, `refs/heads/${DEFAULT_BRANCH}`);
    if (!sha) return;
    files = (await listTree(repoDir, sha))
      .map(e => e.path)
      .filter(p => p.startsWith("users/"));
  }

  // Departed people who still own a folder get a handle too (after members).
  const handles = await planWorkspaceHandles(workspaceId, userSegments(files));
  const all = [...handles.existing, ...handles.assigned];
  const { User } = await import("../database/schema");
  const users = await User.find({ _id: { $in: all.map(h => h.userId) } })
    .select("_id email")
    .lean();
  const emails = new Map(users.map(u => [String(u._id), u.email]));
  const plan = planUserFolderRenames(files, all);
  const ws = await Workspace.findById(workspaceId).select("name").lean();
  printPlan(`${ws?.name ?? "?"} (${workspaceId})`, handles, emails, plan);

  const rewrites = await plannedRowRewrites(workspaceId, plan.renames);
  const byCollection = new Map<string, number>();
  for (const r of rewrites) {
    byCollection.set(r.collection, (byCollection.get(r.collection) ?? 0) + 1);
  }
  console.log(
    `Mongo rows to rewrite (${rewrites.length}): ${
      [...byCollection].map(([c, n]) => `${c}=${n}`).join(", ") || "none"
    }`,
  );
  for (const r of rewrites) {
    console.log(`  ${r.collection} ${r.id}: ${r.from} → ${r.to}`);
  }

  if (!args.write) return;
  if (repoDir === null) {
    // parseArgs refuses --repo with --write; reaching here is a bug.
    throw new Error("--write needs Mako's own clone of the workspace repo");
  }

  const stored = await ensureWorkspaceHandles(workspaceId, userSegments(files));
  // Re-plan against what was actually stored (a concurrent assignment may
  // have won a handle): the commit must use the persisted mapping.
  const finalPlan = planUserFolderRenames(files, stored);
  if (finalPlan.renames.length === 0) {
    console.log("Nothing to rename.");
    return;
  }
  const { commitOnMainDurably, moveWritesUnder } =
    await import("../apps/worktree.service");
  const fileMoves = finalPlan.renames.flatMap(r => r.files);
  const folderMoves = finalPlan.renames.map(r => ({ from: r.from, to: r.to }));
  const dir = repoDir;
  await commitOnMainDurably(
    workspaceId,
    dir,
    async () => ({
      moves: fileMoves,
      // Pin every unstamped app's id in its manifest at the new path, as
      // any app move does: a derived id would otherwise change with it.
      writes: await moveWritesUnder(workspaceId, dir, folderMoves),
    }),
    {
      message: `Rename personal folders to handles (${finalPlan.renames
        .map(r => `${r.from} → ${r.to}`)
        .join(", ")})`,
      author: BOT_AUTHOR,
    },
  );
  console.log(`Committed and pushed ${fileMoves.length} file moves.`);
  const rows = await applyRowRewrites(workspaceId, finalPlan.renames);
  console.log(`Rewrote ${rows} Mongo rows.`);
  const { invalidateOwnerDirectory } =
    await import("../apps/user-handles.service");
  invalidateOwnerDirectory(workspaceId);
}

async function main(): Promise<void> {
  const args = parseArgs();
  const uri = process.env.DATABASE_URL;
  if (!uri) throw new Error("DATABASE_URL is not set");
  await mongoose.connect(uri, {
    ...(process.env.DATABASE_NAME ? { dbName: process.env.DATABASE_NAME } : {}),
    // A dry run must not even build indexes on the target database.
    autoIndex: args.write,
    autoCreate: args.write,
  });
  console.log(
    `${args.write ? "WRITE" : "DRY RUN"} against database ${mongoose.connection.db?.databaseName}`,
  );
  try {
    let workspaceIds: string[];
    if (args.repo) {
      const stamp = JSON.parse(
        readFileSync(path.join(args.repo, ".mako/workspace.json"), "utf8"),
      ) as { workspaceId?: string };
      const id = args.workspaceId ?? stamp.workspaceId;
      if (!id) throw new Error("No workspace id (pass --workspace-id)");
      workspaceIds = [id];
    } else if (args.workspaceId) {
      workspaceIds = [args.workspaceId];
    } else {
      const rows = await Workspace.find({
        $or: [
          { "workspaceRepos.0": { $exists: true } },
          { appsRepo: { $exists: true, $ne: null } },
        ],
      })
        .select("_id")
        .lean();
      workspaceIds = rows.map(r => String(r._id));
    }
    for (const id of workspaceIds) {
      try {
        await migrateWorkspace(id, args);
      } catch (error) {
        console.error(
          `\n!!! ${id}: ${error instanceof Error ? error.stack : String(error)}`,
        );
        process.exitCode = 1;
      }
    }
  } finally {
    await mongoose.disconnect();
  }
}

main().then(
  () => process.exit(process.exitCode ?? 0),
  error => {
    console.error(error);
    process.exit(1);
  },
);
