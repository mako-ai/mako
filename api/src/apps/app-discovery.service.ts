/**
 * App discovery — what the Apps home and its search show about each app.
 *
 * One composition over reads that already exist: the apps index (title,
 * description, path, tables, who first added it), the state rows (owner,
 * deployment, last deploy error, `verified`), and the binding
 * state (data freshness, failed refreshes). Visibility is the list route's,
 * exactly (canSeeIndexedApp), so the home can never show an app the
 * explorer hides. Popularity is NOT here: that is the usage API
 * (app-usage.service), which the UI joins on the app id. Search ranks
 * through app-search.ts, the same ranking as the `search_apps` agent tool.
 */
import mongoose, { Types } from "mongoose";
import { AppProject, type IAppProject } from "../database/workspace-schema";
import { User } from "../database/schema";
import { canSeeIndexedApp } from "./app-authorization";
import {
  loadAppsIndex,
  type AppIndexRow,
  type AppsIndexSnapshot,
} from "./app-index.service";
import { rankApps, type RelatedSignals } from "./app-search";
import { loadOwnerDirectory } from "./user-handles.service";
import {
  resolveAppOwner,
  type AppOwner,
  type PeopleDirectory,
} from "./app-owner";
import type { OwnerDirectory } from "./user-handles";
import { githubIdsOfLogins, loadPeopleDirectory } from "./app-owner.service";
import { verifiedAppIds } from "./app-lifecycle-state";
import { timed } from "../middleware/server-timing";
import "./bindings.service";

export interface DiscoveryApp {
  id: string;
  slug: string;
  path: string;
  scope: "workspace" | "private";
  title: string;
  description?: string;
  access: "private" | "workspace";
  /** The person who owns the app's sharing state, when one does. */
  ownerId?: string;
  /** The owner's workspace handle (`users/<handle>/`), when they have one. */
  ownerHandle?: string;
  ownerEmail?: string;
  /** Who first committed its manifest — the owner of a folder-only app. */
  authorEmail?: string;
  /**
   * The owner as a person, for display: the sharing/tree owner, else the
   * workspace member the author email resolves to (app-owner.ts), else the
   * email's local part (`name` only — no `userId`).
   */
  owner?: AppOwner;
  /** First commit of the manifest, else when the state row appeared. */
  createdAt?: string;
  publishedAt?: string;
  publishedSha?: string;
  /** Curated by an admin (lifecycle lane); rendered as a badge. */
  verified: boolean;
  /** The app's `thumbnail.*` file and blob oid; null = none (placeholder). */
  thumbnail: { file: string; oid: string } | null;
  /** Has at least one scheduled binding. */
  scheduled: boolean;
  tables: string[];
  /** The OLDEST binding's last successful build — what the app shows. */
  dataRefreshedAt: string | null;
  health: {
    deployError?: { stage: string; at: string };
    /** Bindings whose latest run failed. */
    bindingErrors: string[];
  };
}

export interface BindingStateRow {
  projectId: Types.ObjectId;
  name: string;
  lastMaterializedAt?: Date;
  history?: Array<{ status?: "ready" | "error" }>;
}

function bindingStateModel() {
  // Registered by bindings.service (imported above for that side effect).
  return mongoose.model("AppBindingState");
}

const iso = (d: Date | string | undefined | null) =>
  d ? new Date(d).toISOString() : undefined;

/**
 * The fields of an app's state row that visibility and the cards read. Kept
 * to these so the per-request read stays small.
 */
export const APP_STATE_FIELDS =
  "_id access workspaceRole sharedWith owner_id createdBy publishedSha publishedAt lastDeployError createdAt";

export type AppStateRow = Pick<
  IAppProject,
  | "_id"
  | "access"
  | "workspaceRole"
  | "sharedWith"
  | "owner_id"
  | "createdBy"
  | "publishedSha"
  | "publishedAt"
  | "lastDeployError"
  | "createdAt"
>;

/**
 * Every state row of the workspace. Visibility is ALWAYS judged on a fresh
 * read of these (never a memo): an app made private must disappear from the
 * very next request. Concurrent callers share one in-flight query — the
 * Apps home asks for the same rows from four endpoints at once.
 */
const statesInFlight = new Map<string, Promise<AppStateRow[]>>();
export function loadAppStates(workspaceId: string): Promise<AppStateRow[]> {
  const pending = statesInFlight.get(workspaceId);
  if (pending) return pending;
  const run = timed("states", () =>
    AppProject.find({ workspaceId: new Types.ObjectId(workspaceId) })
      .select(APP_STATE_FIELDS)
      .lean()
      .then(rows => rows as unknown as AppStateRow[]),
  ).finally(() => statesInFlight.delete(workspaceId));
  statesInFlight.set(workspaceId, run);
  return run;
}

/**
 * Everything discovery reads that does not depend on who is asking or on
 * the state rows' visibility: the index, the admin marks, the bindings'
 * freshness, the people directory. app-home-base.service memoizes it; the
 * uncached path (listDiscoveryApps) builds a fresh one per call.
 */
export interface DiscoveryBase {
  snapshot: AppsIndexSnapshot;
  directory: OwnerDirectory;
  people: PeopleDirectory;
  verified: Set<string>;
  bindingsByApp: Map<string, BindingStateRow[]>;
  /** Owner user id → email, for the owners the state rows named. */
  emailById: Map<string, string>;
  /** Old-style noreply GitHub logins → GitHub id, as known. */
  githubIdOfLogin: Map<string, string>;
}

export async function loadDiscoveryBase(
  workspaceId: string,
  options: {
    /** Fetch the mirror before reading main (default true). */
    freshen?: boolean;
    /** The state rows, when the caller already read them. */
    states?: AppStateRow[];
    /**
     * Wait for GitHub login lookups (default true). False: use what is
     * known and look the rest up in the background — never on a request.
     */
    waitForGitHub?: boolean;
  } = {},
): Promise<DiscoveryBase> {
  const [snapshot, states, directory, verified] = await Promise.all([
    timed("disc.index", () =>
      loadAppsIndex(workspaceId, { freshen: options.freshen }),
    ),
    options.states ?? loadAppStates(workspaceId),
    timed("disc.directory", () => loadOwnerDirectory(workspaceId)),
    // Admin marks live in app_lifecycle, keyed by app id (no row needed).
    timed("disc.verified", () => verifiedAppIds(workspaceId)),
  ]);
  const stateById = new Map(states.map(s => [s._id.toString(), s]));
  const ownerIds = new Set<string>();
  for (const folder of snapshot.apps) {
    const owner = ownerOf(folder, stateById.get(folder.appId));
    if (owner) ownerIds.add(owner);
  }
  const appIds = snapshot.apps
    .filter(f => Types.ObjectId.isValid(f.appId))
    .map(f => new Types.ObjectId(f.appId));
  const [emailById, bindingRows, people] = await Promise.all([
    timed("disc.users", () => ownerEmails([...ownerIds])),
    timed("disc.bindings", async () =>
      appIds.length === 0
        ? []
        : bindingStateModel()
            .find({ projectId: { $in: appIds } })
            .select({
              projectId: 1,
              name: 1,
              lastMaterializedAt: 1,
              history: { $slice: 1 },
            })
            .lean()
            .then(rows => rows as unknown as BindingStateRow[]),
    ),
    timed("disc.people", () => loadPeopleDirectory(workspaceId, directory)),
  ]);
  const githubIdOfLogin = await timed("disc.github", () =>
    githubIdsOfLogins(
      people.loginsToLookUp(
        snapshot.apps
          .filter(f => !ownerOf(f, stateById.get(f.appId)))
          .map(f => f.authorEmail),
      ),
      people,
      { wait: options.waitForGitHub !== false },
    ),
  );
  const bindingsByApp = new Map<string, BindingStateRow[]>();
  for (const row of bindingRows) {
    const id = row.projectId.toString();
    const list = bindingsByApp.get(id) ?? [];
    list.push(row);
    bindingsByApp.set(id, list);
  }
  return {
    snapshot,
    directory,
    people,
    verified,
    bindingsByApp,
    emailById,
    githubIdOfLogin,
  };
}

async function ownerEmails(ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const users = await User.find({ _id: { $in: ids } })
    .select("_id email")
    .lean();
  return new Map(users.map(u => [String(u._id), u.email]));
}

/**
 * The cards this person can see: the base, judged against fresh state
 * rows. Pure apart from looking up an owner the base has not met yet (a
 * row that changed hands since the base was read).
 */
export async function discoveryAppsFrom(
  base: DiscoveryBase,
  states: AppStateRow[],
  userId: string | undefined,
  role: string | undefined,
): Promise<DiscoveryApp[]> {
  const { snapshot, directory, people, verified, githubIdOfLogin } = base;
  const stateById = new Map(states.map(s => [s._id.toString(), s]));
  const visible = snapshot.apps.filter(folder =>
    canSeeIndexedApp(folder, stateById.get(folder.appId), userId, role),
  );
  let emailById = base.emailById;
  const missing = new Set<string>();
  for (const folder of visible) {
    const owner = ownerOf(folder, stateById.get(folder.appId));
    if (owner && !emailById.has(owner)) missing.add(owner);
  }
  if (missing.size > 0) {
    const extra = await timed("disc.users", () => ownerEmails([...missing]));
    if (extra.size > 0) emailById = new Map([...emailById, ...extra]);
  }

  return visible.map(folder => {
    const state = stateById.get(folder.appId);
    const ownerId = ownerOf(folder, state);
    // Only the bindings the app HAS on main. State rows outlive the files
    // they describe: a renamed or deleted binding leaves its row (and its
    // last build date) behind forever, and the oldest of those made a
    // dashboard refreshed every 15 minutes read "2 months ago".
    const current = new Set(folder.bindings);
    const bindings = (base.bindingsByApp.get(folder.appId) ?? []).filter(b =>
      current.has(b.name),
    );
    let oldest: Date | null = null;
    for (const b of bindings) {
      if (!b.lastMaterializedAt) continue;
      const at = new Date(b.lastMaterializedAt);
      if (!oldest || at < oldest) oldest = at;
    }
    const deployError = state?.lastDeployError;
    return {
      id: folder.appId,
      slug: folder.slug,
      path: folder.path,
      scope: folder.scope,
      title: folder.title,
      description: folder.description,
      access:
        state?.access ?? (folder.scope === "private" ? "private" : "workspace"),
      ...(ownerId ? { ownerId } : {}),
      ...(directory.handleOf(ownerId)
        ? { ownerHandle: directory.handleOf(ownerId) }
        : {}),
      ...(ownerId && emailById.get(ownerId)
        ? { ownerEmail: emailById.get(ownerId) }
        : {}),
      ...(folder.authorEmail ? { authorEmail: folder.authorEmail } : {}),
      ...withOwner(
        resolveAppOwner(
          {
            ownerId,
            ownerHandle: directory.handleOf(ownerId),
            ownerEmail: ownerId ? emailById.get(ownerId) : undefined,
            authorEmail: folder.authorEmail,
          },
          people,
          githubIdOfLogin,
        ),
      ),
      createdAt: folder.firstCommitAt ?? iso(state?.createdAt),
      publishedAt: iso(state?.publishedAt),
      publishedSha: state?.publishedSha,
      verified: folder.scope === "workspace" && verified.has(folder.appId),
      // The app's own picture, when its folder ships one — so a card only
      // asks for an image that exists, versioned by content.
      thumbnail: folder.thumbnail ?? null,
      scheduled: folder.schedules.length > 0,
      tables: folder.tables,
      dataRefreshedAt: oldest ? oldest.toISOString() : null,
      health: {
        ...(deployError
          ? {
              deployError: {
                stage: deployError.stage,
                at: new Date(deployError.at).toISOString(),
              },
            }
          : {}),
        bindingErrors: bindings
          .filter(b => b.history?.[0]?.status === "error")
          .map(b => b.name)
          .sort(),
      },
    };
  });
}

/**
 * Every app this person can see, with its discovery facts — read fresh
 * (jobs, tests). The routes read through app-home-base.service's memo.
 */
export async function listDiscoveryApps(
  workspaceId: string,
  userId: string | undefined,
  role: string | undefined,
): Promise<DiscoveryApp[]> {
  const states = await loadAppStates(workspaceId);
  const base = await loadDiscoveryBase(workspaceId, { states });
  return discoveryAppsFrom(base, states, userId, role);
}

const withOwner = (owner: AppOwner | undefined) => (owner ? { owner } : {});

/** The person behind an app: its sharing owner, else its tree's owner. */
function ownerOf(
  folder: Pick<AppIndexRow, "scope" | "ownerId">,
  state: Pick<IAppProject, "owner_id" | "createdBy"> | undefined,
): string | undefined {
  const fromState = state?.owner_id || state?.createdBy;
  if (fromState && Types.ObjectId.isValid(fromState)) return fromState;
  return folder.scope === "private" ? folder.ownerId : undefined;
}

/**
 * Search the apps this person can see, best first: app-search.ts's ranking
 * (text relevance, usage breaking ties) over title, description, path, the
 * owner's handle/email and the tables the bindings read, then the
 * semantically related apps when `related` is given.
 */
export function searchDiscoveryApps(
  apps: DiscoveryApp[],
  query: string,
  options: {
    limit?: number;
    usage?: Map<string, number> | null;
    /** Semantic signals for the query (app-search.service). */
    related?: RelatedSignals | null;
  } = {},
): Array<DiscoveryApp & { score: number; matches: string[] }> {
  const byId = new Map(apps.map(a => [a.id, a]));
  return rankApps(
    apps.map(a => ({
      appId: a.id,
      path: a.path,
      title: a.title,
      description: a.description,
      owner: [
        a.owner?.name,
        a.owner?.handle,
        a.owner?.email,
        a.ownerHandle,
        a.ownerEmail,
        a.authorEmail,
      ]
        .filter((e, i, all): e is string => !!e && all.indexOf(e) === i)
        .join(" "),
      tables: a.tables,
      usageScore: options.usage?.get(a.id),
    })),
    query,
    { limit: options.limit, related: options.related },
  ).flatMap(hit => {
    const app = byId.get(hit.appId);
    return app ? [{ ...app, score: hit.score, matches: hit.matchedOn }] : [];
  });
}
