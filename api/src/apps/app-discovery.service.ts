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
import { loadAppsIndex, type AppIndexRow } from "./app-index.service";
import { rankApps } from "./app-search";
import { loadOwnerDirectory } from "./user-handles.service";
import { verifiedAppIds } from "./app-lifecycle-state";
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

interface BindingStateRow {
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

/** Every app this person can see, with its discovery facts. */
export async function listDiscoveryApps(
  workspaceId: string,
  userId: string | undefined,
  role: string | undefined,
): Promise<DiscoveryApp[]> {
  const ws = new Types.ObjectId(workspaceId);
  const [snapshot, states, directory, verified] = await Promise.all([
    loadAppsIndex(workspaceId),
    AppProject.find({ workspaceId: ws })
      .select(
        "_id access workspaceRole sharedWith owner_id createdBy publishedSha publishedAt lastDeployError createdAt",
      )
      .lean(),
    loadOwnerDirectory(workspaceId),
    // Admin marks live in app_lifecycle, keyed by app id (no row needed).
    verifiedAppIds(workspaceId),
  ]);
  const stateById = new Map(
    states.map(s => [s._id.toString(), s as IAppProject]),
  );
  const visible = snapshot.apps.filter(folder =>
    canSeeIndexedApp(folder, stateById.get(folder.appId), userId, role),
  );

  const ownerIds = new Set<string>();
  for (const folder of visible) {
    const owner = ownerOf(folder, stateById.get(folder.appId));
    if (owner) ownerIds.add(owner);
  }
  const [users, bindingRows] = await Promise.all([
    ownerIds.size > 0
      ? User.find({ _id: { $in: [...ownerIds] } })
          .select("_id email")
          .lean()
      : Promise.resolve([]),
    bindingStateModel()
      .find({
        projectId: {
          $in: visible
            .filter(f => Types.ObjectId.isValid(f.appId))
            .map(f => new Types.ObjectId(f.appId)),
        },
      })
      .select({
        projectId: 1,
        name: 1,
        lastMaterializedAt: 1,
        history: { $slice: 1 },
      })
      .lean()
      .then(rows => rows as unknown as BindingStateRow[]),
  ]);
  const emailById = new Map(users.map(u => [String(u._id), u.email]));
  const bindingsByApp = new Map<string, BindingStateRow[]>();
  for (const row of bindingRows) {
    const id = row.projectId.toString();
    const list = bindingsByApp.get(id) ?? [];
    list.push(row);
    bindingsByApp.set(id, list);
  }

  return visible.map(folder => {
    const state = stateById.get(folder.appId);
    const ownerId = ownerOf(folder, state);
    // Only the bindings the app HAS on main. State rows outlive the files
    // they describe: a renamed or deleted binding leaves its row (and its
    // last build date) behind forever, and the oldest of those made a
    // dashboard refreshed every 15 minutes read "2 months ago".
    const current = new Set(folder.bindings);
    const bindings = (bindingsByApp.get(folder.appId) ?? []).filter(b =>
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
 * owner's handle/email and the tables the bindings read.
 */
export function searchDiscoveryApps(
  apps: DiscoveryApp[],
  query: string,
  options: { limit?: number; usage?: Map<string, number> | null } = {},
): Array<DiscoveryApp & { score: number; matches: string[] }> {
  const byId = new Map(apps.map(a => [a.id, a]));
  return rankApps(
    apps.map(a => ({
      appId: a.id,
      path: a.path,
      title: a.title,
      description: a.description,
      owner: [a.ownerHandle, a.ownerEmail, a.authorEmail]
        .filter((e): e is string => !!e)
        .join(" "),
      tables: a.tables,
      usageScore: options.usage?.get(a.id),
    })),
    query,
    { limit: options.limit },
  ).flatMap(hit => {
    const app = byId.get(hit.appId);
    return app ? [{ ...app, score: hit.score, matches: hit.matchedOn }] : [];
  });
}
