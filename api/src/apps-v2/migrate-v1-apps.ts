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
import { Types } from "mongoose";
import {
  MakoApp,
  type IMakoApp,
  type IMakoAppDataBinding,
} from "../database/workspace-schema";
import { loggers } from "../logging";
import { createAppsV2Scaffold } from "./scaffold";
import {
  appRootFor,
  commitFilesOnBranch,
  createProject,
} from "./worktree.service";
import { repoDirFor } from "./repository.service";
import { queueMirrorPush } from "./cloud-repo.service";

const logger = loggers.api("apps-v2-migrate-v1");

const BINDING_NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_-]*$/;

export interface V1AppMigrationPlan {
  v1AppId: string;
  title: string;
  fileCount: number;
  bindings: {
    migrated: string[];
    skipped: Array<{ name: string; reason: string }>;
  };
  access: "private" | "workspace";
  alreadyMigrated: boolean;
}

export interface V1AppMigrationResult extends V1AppMigrationPlan {
  projectId?: string;
  slug?: string;
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

/** Render one v1 SQL binding as a v2 binding file (front matter + query). */
function renderBindingFile(binding: IMakoAppDataBinding): string {
  const lines = [`-- connection: ${binding.connectionId}`];
  lines.push("-- materialization: parquet");
  const cron = binding.materializationSchedule?.enabled
    ? binding.materializationSchedule.cron
    : null;
  if (cron) lines.push(`-- schedule: ${cron}`);
  if (binding.dbtProjectId) {
    lines.push(`-- dbt_project: ${binding.dbtProjectId}`);
  }
  return `${lines.join("\n")}\n${binding.code.trim()}\n`;
}

function classifyBindings(app: IMakoApp): {
  files: Record<string, string>;
  migrated: string[];
  skipped: Array<{ name: string; reason: string }>;
} {
  const files: Record<string, string> = {};
  const migrated: string[] = [];
  const skipped: Array<{ name: string; reason: string }> = [];
  const taken = new Set<string>();

  for (const binding of app.dataBindings ?? []) {
    if (binding.language !== "sql") {
      skipped.push({
        name: binding.name,
        reason: `v2 bindings are SQL files; this one is ${binding.language}`,
      });
      continue;
    }
    if (binding.materialization === "live") {
      skipped.push({
        name: binding.name,
        reason: "v2 has no live materialization; convert to parquet manually",
      });
      continue;
    }
    const file = bindingFileName(binding.name, taken);
    files[`bindings/${file}.sql`] = renderBindingFile(binding);
    migrated.push(file);
  }
  return { files, migrated, skipped };
}

/** Merge v1 dependency pins into the scaffold's package.json. */
function mergeDependencies(
  scaffoldPackageJson: string,
  deps: Record<string, string>,
): string {
  const pkg = JSON.parse(scaffoldPackageJson) as {
    dependencies?: Record<string, string>;
  };
  // The v1 pin wins on collision: the app was written against it.
  pkg.dependencies = { ...(pkg.dependencies ?? {}), ...deps };
  return `${JSON.stringify(pkg, null, 2)}\n`;
}

function migrationNotes(
  app: IMakoApp,
  skipped: Array<{ name: string; reason: string }>,
): string {
  const lines = [
    "# Migrated from Apps v1",
    "",
    `Source app: ${app._id.toString()} ("${app.title}"), migrated ${new Date().toISOString()}.`,
    "",
    `The v1 runtime was "${app.runtime}" with entrypoint "${app.entrypoint}".`,
    "v2 apps are ordinary Vite projects: run `npm install && npm run build`",
    "in the sandbox and fix what it names before publishing. The app arrives",
    "UNPUBLISHED on purpose — a v1 published snapshot is a document, a v2",
    "publish is a build of a commit, and nothing has been built yet.",
    "",
  ];
  if (skipped.length > 0) {
    lines.push("## Bindings that could not be migrated", "");
    for (const s of skipped) lines.push(`- \`${s.name}\`: ${s.reason}`);
    lines.push("");
  }
  return `${lines.join("\n")}`;
}

/** Build the plan for one app without writing anything. */
export function planV1AppMigration(app: IMakoApp): V1AppMigrationPlan {
  const { migrated, skipped } = classifyBindings(app);
  return {
    v1AppId: app._id.toString(),
    title: app.title,
    fileCount: (app.files ?? []).length,
    bindings: { migrated, skipped },
    access: app.access === "workspace" ? "workspace" : "private",
    alreadyMigrated: Boolean(
      (app as unknown as { migratedToV2ProjectId?: unknown })
        .migratedToV2ProjectId,
    ),
  };
}

/** Migrate one v1 app into its workspace's v2 repo. Idempotent per app. */
export async function migrateV1App(
  app: IMakoApp,
): Promise<V1AppMigrationResult> {
  const plan = planV1AppMigration(app);
  if (plan.alreadyMigrated) return plan;

  const workspaceId = app.workspaceId.toString();

  // The scaffold first (real Vite chassis), then the v1 files over it — the
  // v1 file wins any collision, because it IS the app. Migrating onto the
  // scaffold rather than raw is what makes the result a v2 app instead of a
  // pile of source with no build.
  const project = await createProject({
    workspaceId,
    title: app.title,
    description: app.description,
    userId: app.owner_id || app.createdBy,
  });

  const scaffold = createAppsV2Scaffold({
    title: app.title,
    description: app.description,
  });
  const overlay: Record<string, string> = {};
  for (const file of app.files ?? []) {
    const rel = file.path.replace(/^\/+/, "");
    if (!rel || rel.includes("..")) continue;
    overlay[rel] = file.contents;
  }
  if (!overlay["package.json"] && Object.keys(app.dependencies ?? {}).length) {
    overlay["package.json"] = mergeDependencies(
      scaffold["package.json"],
      app.dependencies,
    );
  }
  const bindings = classifyBindings(app);
  Object.assign(overlay, bindings.files);
  overlay["MIGRATION.md"] = migrationNotes(app, bindings.skipped);

  const root = appRootFor(project);
  const prefixed: Record<string, string> = {};
  for (const [rel, contents] of Object.entries(overlay)) {
    prefixed[`${root}/${rel}`] = contents;
  }
  await commitFilesOnBranch(
    repoDirFor(workspaceId),
    project.defaultBranch || "main",
    { writes: prefixed },
    { message: `Migrate v1 app "${app.title}" (${app._id.toString()})` },
  );
  queueMirrorPush(workspaceId);

  // Access carries over; publish state deliberately does not (see header).
  if (plan.access !== project.access) {
    project.access = plan.access;
    await project.save();
  }

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
    bindingsMigrated: bindings.migrated.length,
    bindingsSkipped: bindings.skipped.length,
  });
  return { ...plan, projectId: project._id.toString(), slug: project.slug };
}

/** Migrate every v1 app in a workspace (or one app). */
export async function migrateWorkspaceV1Apps(input: {
  workspaceId: string;
  appId?: string;
  execute: boolean;
}): Promise<V1AppMigrationResult[]> {
  const query: Record<string, unknown> = {
    workspaceId: new Types.ObjectId(input.workspaceId),
  };
  if (input.appId) query._id = new Types.ObjectId(input.appId);
  const apps = await MakoApp.find(query);
  const results: V1AppMigrationResult[] = [];
  for (const app of apps) {
    results.push(
      input.execute ? await migrateV1App(app) : planV1AppMigration(app),
    );
  }
  return results;
}
