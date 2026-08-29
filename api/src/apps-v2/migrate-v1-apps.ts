/**
 * Migrate v1 apps (MakoApp documents) into the v2 architecture.
 *
 * A v1 app is a Mongo document: a virtual filesystem (`files[]`), an npm
 * dependency map, and `dataBindings[]` with the query text inline. A v2 app is
 * a folder in the workspace git repo: a real Vite project whose bindings are
 * `bindings/<name>.sql` files with front matter, plus an AppProjectV2 row for
 * what genuinely cannot live in a clonable repo (access, publish state).
 *
 * What migrates, and what deliberately does not:
 *
 * - FILES move verbatim into `apps/<slug>/`, layered over the v2 scaffold so
 *   the result has the chassis a v2 app needs (vite config, tsconfig,
 *   index.html). Where the two collide, the v1 file wins — it is the app.
 * - DEPENDENCIES merge into the scaffold's package.json (v1 pins win).
 * - SQL bindings become `bindings/<name>.sql` with front matter, including
 *   the cron schedule when one was enabled. JavaScript and MongoDB bindings
 *   have no v2 file format yet, and "live" materialization does not exist in
 *   v2 — those are recorded in MIGRATION.md rather than silently dropped.
 * - ACCESS carries over to the project row. PUBLISH does not: a v1 "published
 *   snapshot" is a document, a v2 publish is a build of a commit, and
 *   pretending one is the other would set publishedSha to something that was
 *   never built. Migrated apps arrive unpublished; publishing them is one
 *   click, and doing it eagerly here would deploy before anyone verified the
 *   app still builds as a real Vite project.
 * - The v1 document is left in place, stamped `migratedToV2ProjectId`, so the
 *   migration is re-runnable (stamped apps are skipped) and reversible by
 *   deleting the v2 folder and clearing the stamp.
 *
 * The one thing this cannot promise: that the app BUILDS. v1 apps ran under a
 * CDN/webcontainer runtime, not Vite, so imports may need adjusting. That is
 * app-by-app work an agent can do in the v2 sandbox; the migrator's job is to
 * move the source faithfully into git and say what needs attention.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import mongoose, { Types } from "mongoose";
import {
  MakoApp,
  AppProjectV2,
  EntityVersion,
  type IEntityVersion,
  type IMakoApp,
  type IMakoAppDataBinding,
  type ResourceShareRole,
  type IResourceShareEntry,
} from "../database/workspace-schema";
import { loggers } from "../logging";
import { APP_SDK_DEPENDENCY } from "./app-sdk-package";
import { createAppsV2Scaffold } from "./scaffold";
import {
  appRootFor,
  commitFilesOnBranch,
  createProject,
  deleteProject,
  slugify,
} from "./worktree.service";
import {
  commitSubtreeOnBranch,
  repoDirFor,
  type GitAuthor,
} from "./repository.service";
import { mirrorPushNow, queueMirrorPush } from "./cloud-repo.service";
import { adoptBindingArtifact, readBindings } from "./bindings.service";

const logger = loggers.api("apps-v2-migrate-v1");

const BINDING_NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_-]*$/;

export interface V1AppMigrationPlan {
  v1AppId: string;
  title: string;
  fileCount: number;
  /** Saved v1 versions that replay as git commits (§13.18). */
  versions?: number;
  bindings: {
    migrated: string[];
    skipped: Array<{ name: string; reason: string }>;
    /** Bindings whose current v1 parquet artifact (and last run) carry over as-is. */
    carried: string[];
    /** Live v1 bindings now refreshed on a schedule, with the cron chosen. */
    liveAsScheduled: Array<{ name: string; cron: string }>;
  };
  access: "private" | "workspace";
  /**
   * The full ACL carries over, not just `access`: `workspaceRole` decides
   * whether workspace members may EDIT (and thus dev-run) a workspace-access
   * app, and `sharedWith` names per-user collaborators. Dropping them made
   * every migrated workspace app view-only to everyone but its owner — so
   * members opening one to run it got a misleading "App not found" (the
   * dev-preview write gate, obscured).
   */
  workspaceRole?: ResourceShareRole;
  sharedWith?: IResourceShareEntry[];
  alreadyMigrated: boolean;
}

export interface V1AppMigrationResult extends V1AppMigrationPlan {
  projectId?: string;
  slug?: string;
  /** Git commits created from saved v1 versions (execute mode). */
  versionCommits?: number;
}

/** A safe binding filename from a v1 binding's display name. */
function bindingFileName(name: string, taken: Set<string>): string {
  let base =
    name
      .trim()
      .replace(/[^A-Za-z0-9_-]+/g, "_")
      .replace(/^[_-]+|[_-]+$/g, "")
      .slice(0, 60) || "binding";
  if (!BINDING_NAME_RE.test(base)) base = `b_${base}`;
  let candidate = base;
  for (let i = 2; taken.has(candidate); i++) candidate = `${base}_${i}`;
  taken.add(candidate);
  return candidate;
}

/**
 * A live v1 binding queried the source on every load. v2 serves parquet, so
 * the closest equivalent is a scheduled refresh: the binding's own schedule
 * if it had one, else a cron derived from its freshness TTL, else the
 * scheduler's finest grain (every 15 minutes).
 */
function scheduleForLiveBinding(binding: IMakoAppDataBinding): string {
  const sched = binding.materializationSchedule;
  if (sched?.enabled && sched.cron) return sched.cron;
  const ttl = sched?.dataFreshnessTtlMs ?? null;
  if (ttl == null || ttl <= 15 * 60_000) return "*/15 * * * *";
  if (ttl <= 60 * 60_000) return "0 * * * *";
  if (ttl <= 6 * 60 * 60_000) return "0 */6 * * *";
  return "0 6 * * *";
}

/** Render one v1 SQL binding as a v2 binding file (front matter + query). */
function renderBindingFile(
  binding: IMakoAppDataBinding,
  options: { cron: string | null; wasLive: boolean },
): string {
  const lines = [`-- connection: ${binding.connectionId}`];
  if (binding.databaseId) lines.push(`-- database: ${binding.databaseId}`);
  if (binding.databaseName) {
    lines.push(`-- database_name: ${binding.databaseName}`);
  }
  lines.push("-- materialization: parquet");
  if (options.cron) lines.push(`-- schedule: ${options.cron}`);
  if (binding.materializationSchedule?.timezone) {
    lines.push(`-- timezone: ${binding.materializationSchedule.timezone}`);
  }
  if (binding.dbtProjectId) {
    lines.push(`-- dbt_project: ${binding.dbtProjectId}`);
  }
  if (options.wasLive) {
    lines.push(
      "-- migrated_from: live (v1 queried on every load; v2 refreshes on the schedule above)",
    );
  }
  return `${lines.join("\n")}\n${binding.code.trim()}\n`;
}

function classifyBindings(app: V1AppContent): {
  files: Record<string, string>;
  migrated: string[];
  skipped: Array<{ name: string; reason: string; code?: string }>;
  carried: string[];
  liveAsScheduled: Array<{ name: string; cron: string }>;
  /** v1 binding id → v2 file name, for artifact adoption after the commit. */
  fileNames: Map<string, string>;
} {
  const files: Record<string, string> = {};
  const migrated: string[] = [];
  const skipped: Array<{ name: string; reason: string; code?: string }> = [];
  const carried: string[] = [];
  const liveAsScheduled: Array<{ name: string; cron: string }> = [];
  const fileNames = new Map<string, string>();
  const taken = new Set<string>();
  for (const binding of app.dataBindings ?? []) {
    if (binding.language !== "sql") {
      // v2 has one binding language: SQL, because the consumption stack is
      // DuckDB over parquet. A MongoDB binding's original query is kept in
      // MIGRATION.md so the owner can rewrite it as SQL (its source data is
      // reachable from the warehouse); a JavaScript binding v1 never
      // materialized at all.
      skipped.push({
        name: binding.name,
        reason:
          binding.language === "mongodb"
            ? "MongoDB bindings are not supported in v2 (SQL only) — rewrite the query as SQL; the original is in MIGRATION.md"
            : `v2 bindings are SQL; this one is ${binding.language}`,
        code: binding.language === "mongodb" ? binding.code : undefined,
      });
      continue;
    }
    const file = bindingFileName(binding.name, taken);
    const wasLive = binding.materialization === "live";
    const cron = wasLive
      ? scheduleForLiveBinding(binding)
      : binding.materializationSchedule?.enabled
        ? (binding.materializationSchedule.cron ?? null)
        : null;
    files[`bindings/${file}.sql`] = renderBindingFile(binding, {
      cron,
      wasLive,
    });
    migrated.push(file);
    fileNames.set(binding.id, file);
    if (wasLive && cron) liveAsScheduled.push({ name: file, cron });
    // A ready parquet build is data the app already has; it carries over
    // untouched, so the app arrives with its numbers and the scheduler sees
    // a real last run rather than "never built".
    if (
      binding.cache?.parquetBuildStatus === "ready" &&
      binding.cache.parquetArtifactKey
    ) {
      carried.push(file);
    }
  }
  return { files, migrated, skipped, carried, liveAsScheduled, fileNames };
}

/**
 * The subset of a v1 app that determines its files on disk — satisfied both
 * by the live MakoApp document and by an EntityVersion snapshot, so one
 * overlay builder serves the final state and every replayed version.
 */
interface V1AppContent {
  files?: Array<{ path: string; contents: string }>;
  dependencies?: Record<string, string>;
  dataBindings?: IMakoAppDataBinding[];
}

/**
 * Scaffold + v1 files + rendered bindings for one app state. The v1 file
 * wins any collision with the scaffold — it IS the app.
 */
function buildAppTree(
  content: V1AppContent,
  scaffold: Record<string, string>,
): {
  tree: Record<string, string>;
  bindings: ReturnType<typeof classifyBindings>;
} {
  const overlay: Record<string, string> = {};
  for (const file of content.files ?? []) {
    const rel = file.path.replace(/^\/+/, "");
    if (!rel || rel.includes("..")) continue;
    overlay[rel] = file.contents;
  }
  if (
    !overlay["package.json"] &&
    Object.keys(content.dependencies ?? {}).length
  ) {
    overlay["package.json"] = mergeDependencies(
      scaffold["package.json"],
      content.dependencies ?? {},
    );
  }
  const bindings = classifyBindings(content);
  Object.assign(overlay, bindings.files);
  return { tree: { ...scaffold, ...overlay }, bindings };
}

/**
 * Git authors for version savers. `savedBy` is a user id; the users
 * collection gives the real email (looked up raw — user ids are plain
 * strings). "System" versions (the initial-version backfill) are Mako's own
 * writes and get the Mako author rather than impersonating anyone.
 */
async function resolveVersionAuthors(
  versions: IEntityVersion[],
): Promise<Map<string, { name: string; email: string }>> {
  const ids = [...new Set(versions.map(v => v.savedBy).filter(Boolean))];
  const byId = new Map<string, { name: string; email: string }>();
  if (ids.length > 0) {
    const col = mongoose.connection.db?.collection("users");
    const docs = col
      ? await col
          .find({ _id: { $in: ids as unknown as Types.ObjectId[] } })
          .project({ email: 1, name: 1 })
          .toArray()
      : [];
    for (const doc of docs) {
      const email = typeof doc.email === "string" ? doc.email : undefined;
      if (!email) continue;
      const name =
        typeof doc.name === "string" && doc.name.trim() ? doc.name : email;
      byId.set(String(doc._id), { name, email });
    }
  }
  return byId;
}

function versionAuthor(
  version: IEntityVersion,
  byId: Map<string, { name: string; email: string }>,
): GitAuthor {
  if (version.savedByName === "System") {
    // The backfill wrote these, not a person.
    return { name: "Mako", email: "bot@mako.ai", date: version.createdAt };
  }
  const known = byId.get(version.savedBy);
  if (known) return { ...known, date: version.createdAt };
  const fromName =
    version.savedByName && version.savedByName.includes("@")
      ? version.savedByName
      : undefined;
  return {
    name: version.savedByName || version.savedBy || "Unknown",
    email: fromName ?? `${version.savedBy || "unknown"}@users.invalid`,
    date: version.createdAt,
  };
}

/** Materialize a file map into a directory (for subtree snapshots). */
async function writeTreeToDir(
  tree: Record<string, string>,
  dir: string,
): Promise<void> {
  for (const [rel, contents] of Object.entries(tree)) {
    const abs = path.join(dir, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, contents, "utf8");
  }
}

/** The version's own words, else its number — never an invented message. */
function versionMessage(version: IEntityVersion): string {
  const comment = (version.comment ?? "").trim();
  return comment || `v${version.version}`;
}

/** Merge v1 dependency pins into the scaffold's package.json. */
function mergeDependencies(
  scaffoldPackageJson: string,
  deps: Record<string, string>,
): string {
  const pkg = JSON.parse(scaffoldPackageJson) as {
    dependencies?: Record<string, string>;
  };
  // The v1 pin wins on collision: the app was written against it. The SDK
  // dependency rides along unconditionally — v1 injected @mako/app-sdk at
  // runtime, so any v1 app may import it, and in v2 the import resolves to
  // the real package committed at packages/app-sdk.
  pkg.dependencies = {
    ...(pkg.dependencies ?? {}),
    ...deps,
    ...APP_SDK_DEPENDENCY,
  };
  return `${JSON.stringify(pkg, null, 2)}\n`;
}

function migrationNotes(
  app: IMakoApp,
  skipped: Array<{ name: string; reason: string; code?: string }>,
  versionsReplayed: number,
): string {
  const lines = [
    "# Migrated from Apps v1",
    "",
    `Source app: ${app._id.toString()} ("${app.title}"), migrated ${new Date().toISOString()}.`,
    "",
    `The v1 runtime was "${app.runtime}" with entrypoint "${app.entrypoint}".`,
    ...(versionsReplayed > 0
      ? [
          `${versionsReplayed} saved v1 version${versionsReplayed === 1 ? "" : "s"} were replayed as the git commits before this one,`,
          "with their original authors, timestamps, and version comments.",
          "",
        ]
      : []),
    "v2 apps are ordinary Vite projects: run `npm install && npm run build`",
    "in the sandbox and fix what it names before publishing. The app arrives",
    "UNPUBLISHED on purpose — a v1 published snapshot is a document, a v2",
    "publish is a build of a commit, and nothing has been built yet.",
    "",
  ];
  if (skipped.length > 0) {
    lines.push("## Bindings that could not be migrated", "");
    for (const b of skipped) {
      lines.push(`- \`${b.name}\`: ${b.reason}`);
      if (b.code) {
        lines.push(
          "",
          "  Original query (rewrite as SQL):",
          "",
          "  ```",
          ...b.code
            .trim()
            .split("\n")
            .map(l => `  ${l}`),
          "  ```",
          "",
        );
      }
    }
    lines.push("");
  }
  return `${lines.join("\n")}`;
}

/** Build the plan for one app without writing anything. */
export function planV1AppMigration(app: IMakoApp): V1AppMigrationPlan {
  const { migrated, skipped, carried, liveAsScheduled } = classifyBindings(app);
  const access = app.access === "workspace" ? "workspace" : "private";
  return {
    v1AppId: app._id.toString(),
    title: app.title,
    fileCount: (app.files ?? []).length,
    bindings: { migrated, skipped, carried, liveAsScheduled },
    access,
    // Workspace apps are the team's shared apps. A migrated app arrives
    // UNPUBLISHED, and the only way to see an unpublished v2 app is dev mode —
    // which needs editor. v1 workspace apps were viewer for members, but there
    // the team could still *view* the rendered dashboard; here viewer would
    // lock every member out of the app entirely until an owner republishes.
    // So workspace apps migrate as `editor` for members: the team can open and
    // run them, exactly as they used the v1 dashboards. Private apps stay
    // owner-only regardless of this field.
    workspaceRole: access === "workspace" ? "editor" : app.workspaceRole,
    sharedWith: app.sharedWith,
    alreadyMigrated: Boolean(
      (app as unknown as { migratedToV2ProjectId?: unknown })
        .migratedToV2ProjectId,
    ),
  };
}

/**
 * Migrate one v1 app into its workspace's v2 repo at a deterministic `slug`.
 *
 * Idempotent by OVERWRITE, not by skip: every run re-materializes the app at
 * `slug`, clearing any prior occupant first (folder + row), so re-running —
 * or iterating on this script — reproduces the same result instead of piling
 * up "…-2" duplicates. The caller assigns `slug` deterministically so the same
 * v1 app always lands in the same place.
 */
export async function migrateV1App(
  app: IMakoApp,
  slug: string,
): Promise<V1AppMigrationResult> {
  const plan = planV1AppMigration(app);
  const workspaceId = app.workspaceId.toString();

  // Overwrite: drop whatever currently owns this slug (a previous run, a
  // hand-made app, a leftover from before the DB was re-cloned) so the new
  // migration is the sole occupant. deleteProject removes the folder and the
  // row; a fresh createProject then rebuilds it.
  const existing = await AppProjectV2.findOne({
    workspaceId: new Types.ObjectId(workspaceId),
    slug,
  });
  if (existing) await deleteProject(existing);

  // The scaffold first (real Vite chassis), then the v1 files over it — the
  // v1 file wins any collision, because it IS the app. Migrating onto the
  // scaffold rather than raw is what makes the result a v2 app instead of a
  // pile of source with no build.
  const project = await createProject({
    workspaceId,
    title: app.title,
    description: app.description,
    userId: app.owner_id || app.createdBy,
    slug,
  });

  const scaffold = createAppsV2Scaffold({
    title: app.title,
    description: app.description,
  });
  const root = appRootFor(project);
  const repoDir = repoDirFor(workspaceId);
  const branch = project.defaultBranch || "main";

  // §13.18: every saved v1 version becomes a git commit — original author,
  // original timestamp, the version's own comment as the message — replayed
  // oldest-first so `git log apps/<slug>` IS the app's recorded history.
  // Each version snapshot is a complete file state, so each commit is that
  // state grafted over the scaffold (same rule as the final state: the v1
  // file wins).
  const versions = await EntityVersion.find({
    entityType: "app",
    entityId: app._id,
  }).sort({ version: 1 });
  const authorsById = await resolveVersionAuthors(versions);
  let versionCommits = 0;
  for (const version of versions) {
    const snap = version.snapshot as unknown as V1AppContent;
    const { tree } = buildAppTree(snap, scaffold);
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "mako-v1-replay-"));
    try {
      await writeTreeToDir(tree, workDir);
      await commitSubtreeOnBranch(repoDir, branch, root, workDir, {
        message: versionMessage(version),
        author: versionAuthor(version, authorsById),
      });
      versionCommits += 1;
    } finally {
      await fs.rm(workDir, { recursive: true, force: true });
    }
  }

  // The final commit is the app's CURRENT state (autosaves after the last
  // checkpoint included), replacing the folder wholesale so files deleted
  // since the last version disappear too. This one is the migration's own
  // act, so it carries the Mako author and today's date.
  const { tree: finalTree, bindings } = buildAppTree(app, scaffold);
  finalTree["MIGRATION.md"] = migrationNotes(
    app,
    bindings.skipped,
    versionCommits,
  );
  const prefixed: Record<string, string> = {};
  for (const [rel, contents] of Object.entries(finalTree)) {
    prefixed[`${root}/${rel}`] = contents;
  }
  await commitFilesOnBranch(
    repoDir,
    branch,
    { deletePrefixes: [root], writes: prefixed },
    { message: `Migrate v1 app "${app.title}" (${app._id.toString()})` },
  );
  queueMirrorPush(workspaceId);

  // Carry the data: copy each ready v1 artifact to the v2 binding's
  // content-addressed key and record its build as this binding's last run. No
  // re-query, no gap in the numbers. The v2 binding (read back from the repo
  // we just committed) is what determines the target key, so it matches what
  // the dev server and scheduler will look up.
  const adopted: string[] = [];
  const v2Bindings = await readBindings(
    project,
    app.owner_id || app.createdBy || "system",
  );
  const v2ByName = new Map(v2Bindings.map(b => [b.name, b]));
  for (const binding of app.dataBindings ?? []) {
    const file = bindings.fileNames.get(binding.id);
    const cache = binding.cache;
    if (
      !file ||
      cache?.parquetBuildStatus !== "ready" ||
      !cache.parquetArtifactKey
    ) {
      continue;
    }
    const v2Binding = v2ByName.get(file);
    if (!v2Binding) continue;
    try {
      const ok = await adoptBindingArtifact({
        projectId: project._id.toString(),
        name: file,
        binding: v2Binding,
        fromKey: cache.parquetArtifactKey,
        builtAt: cache.parquetBuiltAt ?? cache.lastRefreshedAt ?? new Date(),
        rowCount: cache.rowCount,
        byteSize: cache.byteSize,
      });
      if (ok) {
        adopted.push(file);
      } else {
        // Not an error on principle — the artifact simply is not in THIS
        // environment's store (a dev/preview clone carries prod keys). Say
        // so instead of silently carrying nothing: the app needs a fresh
        // materialize before its data renders.
        logger.warn(
          "v1 binding artifact not in this environment's store — not carried",
          {
            v1AppId: app._id.toString(),
            binding: file,
            fromKey: cache.parquetArtifactKey,
          },
        );
      }
    } catch (error) {
      logger.warn("Could not carry a v1 binding artifact into v2", {
        v1AppId: app._id.toString(),
        binding: binding.name,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  plan.bindings.carried = adopted;

  // The ACL carries over — access, the workspace-member role, and per-user
  // collaborators — so a migrated app is exactly as visible and editable as
  // its v1 original. Only publish state is deliberately dropped (see header).
  let aclChanged = false;
  if (plan.access !== project.access) {
    project.access = plan.access;
    aclChanged = true;
  }
  if (plan.workspaceRole && plan.workspaceRole !== project.workspaceRole) {
    project.workspaceRole = plan.workspaceRole;
    aclChanged = true;
  }
  if (plan.sharedWith && plan.sharedWith.length > 0) {
    project.sharedWith = plan.sharedWith;
    aclChanged = true;
  }
  if (aclChanged) await project.save();

  // Stamp the SOURCE, not just the destination: re-runs skip stamped apps,
  // and un-migrating is "delete the folder, clear the stamp".
  await MakoApp.updateOne(
    { _id: app._id },
    { $set: { migratedToV2ProjectId: project._id } },
  );

  logger.info("Migrated v1 app to v2", {
    v1AppId: app._id.toString(),
    projectId: project._id.toString(),
    slug: project.slug,
    files: plan.fileCount,
    versionCommits,
    bindingsMigrated: bindings.migrated.length,
    bindingsSkipped: bindings.skipped.length,
  });
  return {
    ...plan,
    versions: versions.length,
    versionCommits,
    projectId: project._id.toString(),
    slug: project.slug,
  };
}

/**
 * A stable slug per v1 app, independent of run order, so re-running the
 * migration overwrites the same folder every time. Apps whose titles slug to
 * the same base are disambiguated by a short suffix of their v1 id —
 * deterministic, unlike the arrival-order "-2" that `uniqueSlug` would assign.
 */
export function deterministicSlugs(apps: IMakoApp[]): Map<string, string> {
  const baseCount = new Map<string, number>();
  for (const app of apps) {
    const base = slugify(app.title?.trim() || "Untitled app");
    baseCount.set(base, (baseCount.get(base) ?? 0) + 1);
  }
  const slugs = new Map<string, string>();
  for (const app of apps) {
    const base = slugify(app.title?.trim() || "Untitled app");
    const id = app._id.toString();
    slugs.set(
      id,
      (baseCount.get(base) ?? 0) > 1 ? `${base}-${id.slice(-6)}` : base,
    );
  }
  return slugs;
}

/**
 * Remove EVERY v2 app in a workspace — folders (one commit) and rows — and
 * clear the v1 migration stamps, returning the repo to "no apps yet". Used by
 * `--reset` so a remigration starts from a clean slate rather than layering
 * onto leftovers.
 */
export async function clearWorkspaceV2Apps(workspaceId: string): Promise<{
  projectsDeleted: number;
  stampsCleared: number;
}> {
  const ws = new Types.ObjectId(workspaceId);
  const projects = await AppProjectV2.find({ workspaceId: ws });
  for (const project of projects) {
    await deleteProject(project);
  }
  const stamp = await MakoApp.updateMany(
    { workspaceId: ws, migratedToV2ProjectId: { $exists: true } },
    { $unset: { migratedToV2ProjectId: "" } },
  );
  return {
    projectsDeleted: projects.length,
    stampsCleared: stamp.modifiedCount ?? 0,
  };
}

/** Migrate every v1 app in a workspace (or one app). */
export async function migrateWorkspaceV1Apps(input: {
  workspaceId: string;
  appId?: string;
  execute: boolean;
  /** Wipe all existing v2 apps first (see clearWorkspaceV2Apps). */
  reset?: boolean;
}): Promise<V1AppMigrationResult[]> {
  if (input.execute && input.reset && !input.appId) {
    const cleared = await clearWorkspaceV2Apps(input.workspaceId);
    logger.info("Apps v2 migration reset: cleared existing apps", {
      workspaceId: input.workspaceId,
      ...cleared,
    });
  }
  const query: Record<string, unknown> = {
    workspaceId: new Types.ObjectId(input.workspaceId),
  };
  if (input.appId) query._id = new Types.ObjectId(input.appId);
  const apps = await MakoApp.find(query);
  // Slugs are computed over the FULL workspace app set (not the filtered
  // query), so a single-app migration lands on the same slug it would in a
  // full run.
  const all = input.appId
    ? await MakoApp.find({ workspaceId: new Types.ObjectId(input.workspaceId) })
    : apps;
  const slugs = deterministicSlugs(all);
  // Version counts up front so a dry run already shows how much history
  // each app will replay.
  const versionCounts = new Map<string, number>();
  const grouped = (await EntityVersion.aggregate([
    {
      $match: { entityType: "app", entityId: { $in: apps.map(a => a._id) } },
    },
    { $group: { _id: "$entityId", n: { $sum: 1 } } },
  ])) as Array<{ _id: Types.ObjectId; n: number }>;
  for (const row of grouped) versionCounts.set(String(row._id), row.n);
  const results: V1AppMigrationResult[] = [];
  for (const app of apps) {
    const slug = slugs.get(app._id.toString()) ?? slugify(app.title);
    results.push(
      input.execute
        ? await migrateV1App(app, slug)
        : {
            ...planV1AppMigration(app),
            versions: versionCounts.get(app._id.toString()) ?? 0,
          },
    );
  }
  // The per-app tail pushes are fire-and-forget; the operator CLI exits the
  // process explicitly, which would cut the LAST app's trailing push. Await
  // one final push so everything is on the mirror before the CLI reports.
  if (input.execute && results.length > 0) {
    await mirrorPushNow(input.workspaceId);
  }
  return results;
}
