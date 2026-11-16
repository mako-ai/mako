/**
 * Backfill the owner of app rows that have none.
 *
 * ensureProjectRow stamped an owner only for 24-hex actor ids (isUserActor),
 * and real Mako user ids are 15 characters (auth.service.ts generateId). So
 * every row a real person materialized in the workspace tree (publish, share,
 * restrict, env) was created ownerless. This module finds each such row's
 * real owner from evidence, in order, before the owner stamp switches to
 * isPersonActorId:
 *
 *   a. personal-tree  users/<handle>/apps/…: the person the workspace's
 *                     handle mapping names for <handle>. Deterministic.
 *   b. folder-author  apps/…: the author of the commit on main that created
 *                     the folder's mako.json (followed across moves), mapped
 *                     to a Mako user by email, who must still be a member.
 *   d. scaffold-builder  apps/… created by Mako's own scaffold commit
 *                     (author bot@mako.ai, "Create app …": app_create_app
 *                     commits as Mako, not as the person): the person whose
 *                     personal tree it was scaffolded into, else the one
 *                     person who committed to the folder in the 24 hours
 *                     after the scaffold. Any second or unknown author
 *                     names no one.
 *   c. none           anything else stays ownerless and is reported.
 *
 * Only a person ever becomes an owner (isPersonActorId): publish, api-key,
 * scheduler, app-chat and other sentinels never do. A row with an owner_id
 * or a createdBy is never touched (resource-acl already reads createdBy as
 * the owner). Applying sets only rows that are still ownerless at write
 * time, so a second run changes nothing.
 */
import { Types } from "mongoose";
import {
  AppIndexEntry,
  AppProject,
  WorkspaceMember,
} from "../database/workspace-schema";
import { User } from "../database/schema";
import {
  APPS_DIR,
  APP_MANIFEST,
  USERS_DIR,
  parseAppRepoPath,
} from "./app-paths";
import { runGit } from "./git";
import { DEFAULT_BRANCH } from "./repository.service";
import { OwnerDirectory } from "./user-handles";
import { planWorkspaceHandles } from "./user-handles.service";
import { isPersonActorId } from "./worktree/worktrees";

/** A creating commit that adds more app manifests than this is a sweep. */
export const CREATION_SWEEP_LIMIT = 3;

export type OwnerRule =
  "personal-handle" | "folder-author" | "scaffold-builder" | "none";

/** The author Mako's server-side scaffold commits carry (repository.service). */
export const MAKO_SCAFFOLD_AUTHOR = "bot@mako.ai";
/** How long after a scaffold the person building the app is looked for. */
export const SCAFFOLD_BUILDER_WINDOW_SECONDS = 24 * 60 * 60;

/** What git says about who built an app Mako scaffolded. */
export type ScaffoldEvidence =
  | { missing: string }
  | {
      /** users/<segment>/apps/… when the scaffold landed in a personal tree. */
      personalSegment?: string;
      /** Commit author emails on the folder in the window, scaffold excluded. */
      builderEmails: string[];
    };

/** A row the backfill considers: ownerless by both owner_id and createdBy. */
export interface OwnerlessRow {
  appId: string;
  workspaceId: string;
  /** Repo-relative app folder (the index's path, else the row's). */
  path: string;
  access: "private" | "workspace";
}

export interface OwnerProposal extends OwnerlessRow {
  rule: OwnerRule;
  /** Set only when rule is a or b. */
  ownerId?: string;
  /** Why rule c applied. */
  reason?: string;
}

/** Where the evidence comes from, per workspace (injected for tests). */
export interface WorkspaceOwnerSources {
  /** The user the handle mapping names for a users/<handle> segment. */
  ownerOfHandle(handle: string): string | null;
  /** Who created the folder on main, or why nobody can be named. */
  folderCreator(
    appPath: string,
  ): Promise<{ email: string } | { missing: string }>;
  /** A Mako user id for a commit email, if one exists. */
  userIdForEmail(email: string): Promise<string | undefined>;
  /** Whether the user is a member of this workspace today. */
  isMember(userId: string): boolean;
  /** Who built an app whose creating commit is Mako's scaffold. */
  scaffoldEvidence(appPath: string): Promise<ScaffoldEvidence>;
}

/** Mongo filter for "no owner at all", matching what resource-acl reads. */
export const OWNERLESS_FILTER = {
  owner_id: { $in: [null, ""] },
  createdBy: { $in: [null, ""] },
};

/** Derive one row's owner. Pure over its sources. */
export async function proposeOwner(
  row: OwnerlessRow,
  sources: WorkspaceOwnerSources,
): Promise<OwnerProposal> {
  const none = (reason: string): OwnerProposal => ({
    ...row,
    rule: "none",
    reason,
  });
  const location = parseAppRepoPath(row.path);
  if (!location) {
    return none(
      row.path.startsWith(`${USERS_DIR}/`)
        ? "personal path names no handle"
        : "not an app path",
    );
  }
  if (location.scope === "private") {
    const owner = sources.ownerOfHandle(location.ownerHandle ?? "");
    if (!owner) return none("handle is nobody's");
    if (!isPersonActorId(owner)) return none("handle maps to a non-person id");
    return { ...row, rule: "personal-handle", ownerId: owner };
  }
  // A private row in the workspace tree was restricted on purpose, by
  // someone with sharing rights. ensureProjectRow never claims such a row,
  // and the backfill does not decide who may see it either.
  if (row.access === "private") return none("private row in workspace tree");
  const creator = await sources.folderCreator(row.path);
  if ("missing" in creator) return none(creator.missing);
  if (creator.email === MAKO_SCAFFOLD_AUTHOR) {
    return proposeScaffoldBuilder(row, sources, none);
  }
  const userId = await sources.userIdForEmail(creator.email);
  if (!userId) return none("creating author is not a Mako user");
  if (!isPersonActorId(userId)) return none("creating author is not a person");
  if (!sources.isMember(userId)) return none("creating author left workspace");
  return { ...row, rule: "folder-author", ownerId: userId };
}

/** Rule d: the person behind a folder Mako's scaffold commit created. */
async function proposeScaffoldBuilder(
  row: OwnerlessRow,
  sources: WorkspaceOwnerSources,
  none: (reason: string) => OwnerProposal,
): Promise<OwnerProposal> {
  const evidence = await sources.scaffoldEvidence(row.path);
  if ("missing" in evidence) return none(evidence.missing);
  const accept = (userId: string | null | undefined, why: string) => {
    if (!userId || !isPersonActorId(userId)) return none(why);
    if (!sources.isMember(userId)) {
      return none("scaffold builder left workspace");
    }
    return { ...row, rule: "scaffold-builder" as const, ownerId: userId };
  };
  if (evidence.personalSegment !== undefined) {
    // createProject files a personal app under its creator's tree. The
    // segment is a handle, or (before handles) the creator's own user id.
    const seg = evidence.personalSegment;
    return accept(
      sources.ownerOfHandle(seg) ?? (isPersonActorId(seg) ? seg : null),
      "scaffolded into a personal tree nobody holds",
    );
  }
  const people = new Set<string>();
  for (const email of evidence.builderEmails) {
    // Mako's own identities (bot, session, agent, publish) are no one.
    if (email.endsWith("@mako.ai")) continue;
    const userId = await sources.userIdForEmail(email);
    if (!userId) return none("unknown author after scaffold");
    people.add(userId);
  }
  if (people.size === 0) return none("nobody committed after scaffold");
  if (people.size > 1) {
    return none(`${people.size} people committed after scaffold`);
  }
  return accept([...people][0], "scaffold builder is not a person");
}

/**
 * Who built an app whose creating commit is Mako's scaffold: the personal
 * tree it was scaffolded into, or every commit author on the folder (under
 * its scaffolded path or its current one) within
 * SCAFFOLD_BUILDER_WINDOW_SECONDS after the scaffold, on main.
 */
export async function scaffoldEvidenceFromGit(
  repoDir: string,
  appPath: string,
  ref = `refs/heads/${DEFAULT_BRANCH}`,
): Promise<ScaffoldEvidence> {
  let log: string;
  try {
    ({ stdout: log } = await runGit(
      [
        "-C",
        repoDir,
        "log",
        ref,
        "--follow",
        "--diff-filter=A",
        "--format=%H%x09%ct%x09%ae%x09%s",
        "--",
        `${appPath}/${APP_MANIFEST}`,
      ],
      { timeoutMs: 60_000 },
    ));
  } catch {
    return { missing: "git log failed" };
  }
  const lines = log.split("\n").filter(Boolean);
  if (lines.length !== 1) return { missing: "no single creating commit" };
  const [sha, ct, email, subject] = (lines[0] ?? "").split("\t");
  if (!sha || !ct || email?.toLowerCase() !== MAKO_SCAFFOLD_AUTHOR) {
    return { missing: "creating commit is not a Mako scaffold" };
  }
  if (!subject?.startsWith('Create app "')) {
    return { missing: "creating commit is not a Mako scaffold" };
  }
  const { stdout: added } = await runGit(
    [
      "-C",
      repoDir,
      "show",
      "--format=",
      "--name-only",
      "--diff-filter=A",
      "--no-renames",
      sha,
    ],
    { timeoutMs: 60_000 },
  );
  const manifests = added
    .split("\n")
    .filter(f => f.endsWith(`/${APP_MANIFEST}`));
  if (manifests.length !== 1) {
    return { missing: "scaffold commit created several apps" };
  }
  const scaffoldPath = (manifests[0] ?? "").slice(
    0,
    -`/${APP_MANIFEST}`.length,
  );
  const segments = scaffoldPath.split("/");
  if (segments[0] === USERS_DIR && segments[2] === APPS_DIR && segments[1]) {
    return { personalSegment: segments[1], builderEmails: [] };
  }
  const since = Number(ct);
  const { stdout: after } = await runGit(
    [
      "-C",
      repoDir,
      "log",
      ref,
      `--since=${new Date(since * 1000).toISOString()}`,
      `--until=${new Date((since + SCAFFOLD_BUILDER_WINDOW_SECONDS) * 1000).toISOString()}`,
      "--format=%H%x09%ae",
      "--",
      scaffoldPath,
      ...(scaffoldPath === appPath ? [] : [appPath]),
    ],
    { timeoutMs: 60_000 },
  );
  const builderEmails = after
    .split("\n")
    .filter(Boolean)
    .map(l => l.split("\t"))
    .filter(([h]) => h !== sha)
    .map(([, e]) => (e ?? "").trim().toLowerCase())
    .filter(Boolean);
  return { builderEmails };
}

/**
 * The author email of the commit on main that created `appPath`'s
 * mako.json, following renames back to the original add. A commit that
 * adds more than CREATION_SWEEP_LIMIT app manifests (an import, a bulk
 * copy) is nobody's authorship and names no one.
 */
export async function folderCreatorFromGit(
  repoDir: string,
  appPath: string,
  ref = `refs/heads/${DEFAULT_BRANCH}`,
): Promise<{ email: string } | { missing: string }> {
  const manifest = `${appPath}/${APP_MANIFEST}`;
  let log: string;
  try {
    ({ stdout: log } = await runGit(
      [
        "-C",
        repoDir,
        "log",
        ref,
        "--follow",
        "--diff-filter=A",
        "--format=%H%x09%ae",
        "--",
        manifest,
      ],
      { timeoutMs: 60_000 },
    ));
  } catch {
    return { missing: "git log failed" };
  }
  const lines = log.split("\n").filter(Boolean);
  // Newest first: the last add is the original creation.
  const oldest = lines[lines.length - 1];
  if (!oldest) return { missing: "no creating commit on main" };
  // Added more than once (deleted and recreated, or restored): the oldest
  // add may belong to a different app at the same path, so name no one.
  if (lines.length > 1) {
    return {
      missing: `folder created more than once on main (${lines.length} adds)`,
    };
  }
  const [sha, email] = oldest.split("\t");
  if (!sha || !email) return { missing: "creating commit has no author" };
  const { stdout: added } = await runGit(
    [
      "-C",
      repoDir,
      "show",
      "--format=",
      "--name-only",
      "--diff-filter=A",
      "--no-renames",
      sha,
      "--",
      APPS_DIR,
      USERS_DIR,
    ],
    { timeoutMs: 60_000 },
  );
  const manifests = added
    .split("\n")
    .filter(f => f.endsWith(`/${APP_MANIFEST}`)).length;
  if (manifests > CREATION_SWEEP_LIMIT) {
    return { missing: `created in a sweep commit (${manifests} apps)` };
  }
  return { email: email.trim().toLowerCase() };
}

/** Every ownerless row, with the path the apps index knows it by. */
export async function findOwnerlessRows(
  workspaceId?: string,
): Promise<OwnerlessRow[]> {
  const filter: Record<string, unknown> = { ...OWNERLESS_FILTER };
  if (workspaceId) filter.workspaceId = new Types.ObjectId(workspaceId);
  const rows = await AppProject.find(filter)
    .select("_id workspaceId path slug access")
    .lean();
  if (rows.length === 0) return [];
  const entries = await AppIndexEntry.find({
    appId: { $in: rows.map(r => r._id.toString()) },
  })
    .select("appId workspaceId path")
    .lean();
  const pathOf = new Map(
    entries.map(e => [`${e.workspaceId.toString()}:${e.appId}`, e.path]),
  );
  return rows.map(r => {
    const appId = r._id.toString();
    const ws = r.workspaceId.toString();
    return {
      appId,
      workspaceId: ws,
      path:
        pathOf.get(`${ws}:${appId}`) ??
        r.path ??
        `${APPS_DIR}/${r.slug ?? appId}`,
      access: r.access === "private" ? "private" : "workspace",
    };
  });
}

/**
 * The sources for one workspace, read-only: stored handles only (the
 * directory a dry run must not create), members, and users by email.
 * `repoDir` null means no bound repo, so rule b has no history to read.
 */
export async function workspaceOwnerSources(
  workspaceId: string,
  repoDir: string | null,
): Promise<WorkspaceOwnerSources> {
  const [{ existing }, members] = await Promise.all([
    planWorkspaceHandles(workspaceId),
    WorkspaceMember.find({ workspaceId: new Types.ObjectId(workspaceId) })
      .select("userId")
      .lean(),
  ]);
  const directory = new OwnerDirectory(existing);
  const memberIds = new Set(members.map(m => String(m.userId)));
  return {
    ownerOfHandle: handle => directory.ownerOf(handle),
    folderCreator: async appPath =>
      repoDir
        ? folderCreatorFromGit(repoDir, appPath)
        : { missing: "workspace has no bound repo" },
    scaffoldEvidence: async appPath =>
      repoDir
        ? scaffoldEvidenceFromGit(repoDir, appPath)
        : { missing: "workspace has no bound repo" },
    userIdForEmail: async email => {
      const user = await User.findOne({ email: email.toLowerCase() })
        .select("_id")
        .lean();
      return user ? String(user._id) : undefined;
    },
    isMember: userId => memberIds.has(userId),
  };
}

/**
 * Write each proposal that names an owner, only onto a row that is still
 * ownerless. Returns how many rows changed; a re-run returns 0.
 */
export async function applyOwnerProposals(
  proposals: OwnerProposal[],
): Promise<number> {
  let changed = 0;
  for (const p of proposals) {
    if (!p.ownerId || p.rule === "none" || !isPersonActorId(p.ownerId)) {
      continue;
    }
    const result = await AppProject.updateOne(
      {
        _id: new Types.ObjectId(p.appId),
        workspaceId: new Types.ObjectId(p.workspaceId),
        ...OWNERLESS_FILTER,
      },
      { $set: { owner_id: p.ownerId, createdBy: p.ownerId } },
    );
    changed += result.modifiedCount;
  }
  return changed;
}

/** A user id short enough to print: enough to recognise, not to paste. */
export function ownerPrefix(ownerId: string | undefined): string {
  return ownerId ? `${ownerId.slice(0, 6)}…` : "-";
}

/** Counts per rule and the review table. No emails, no full ids. */
export function formatOwnerReport(proposals: OwnerProposal[]): string {
  const count = (rule: OwnerRule) =>
    proposals.filter(p => p.rule === rule).length;
  const lines = [
    `ownerless rows: ${proposals.length}`,
    `  a personal-handle: ${count("personal-handle")}`,
    `  b folder-author:   ${count("folder-author")}`,
    `  d scaffold-builder: ${count("scaffold-builder")}`,
    `  c none:            ${count("none")}`,
    "",
    ["appId", "path", "owner", "rule", "reason"].join("\t"),
    ...proposals.map(p =>
      [p.appId, p.path, ownerPrefix(p.ownerId), p.rule, p.reason ?? ""].join(
        "\t",
      ),
    ),
  ];
  return lines.join("\n");
}
