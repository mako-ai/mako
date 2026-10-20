/**
 * Who an app belongs to — the Mongo (and GitHub) half of app-owner.ts.
 *
 * Loads the workspace's people once (members, plus anyone holding a handle
 * here: a departed member still owns what they built), with the sign-ins
 * linked to their accounts, and memoizes it briefly so the Apps home and
 * its search resolve every app's owner from one read.
 */
import { Types } from "mongoose";
import { OAuthAccount, User } from "../database/schema";
import { Workspace, WorkspaceMember } from "../database/workspace-schema";
import { loggers } from "../logging";
import {
  PeopleDirectory,
  workspaceEmailDomains,
  type WorkspacePerson,
} from "./app-owner";
import type { OwnerDirectory } from "./user-handles";

const logger = loggers.api("apps-owner");

/** Membership changes are rare; a minute's delay to show a newcomer is fine. */
const TTL_MS = 60_000;

const cache = new Map<
  string,
  { at: number; handles: OwnerDirectory; people: PeopleDirectory }
>();

/**
 * The workspace's people, indexed for owner resolution. `handles` is the
 * handle directory the caller already loaded (loadOwnerDirectory); a new one
 * (a handle assigned since) refreshes the memo.
 */
export async function loadPeopleDirectory(
  workspaceId: string,
  handles: OwnerDirectory,
): Promise<PeopleDirectory> {
  const hit = cache.get(workspaceId);
  if (hit && hit.handles === handles && Date.now() - hit.at < TTL_MS) {
    return hit.people;
  }
  const ws = new Types.ObjectId(workspaceId);
  const [members, workspace] = await Promise.all([
    WorkspaceMember.find({ workspaceId: ws }).select("userId").lean(),
    Workspace.findById(ws).select("settings.autoJoin").lean(),
  ]);
  const handleOf = new Map(handles.rows().map(r => [r.userId, r.handle]));
  const ids = [
    ...new Set([...members.map(m => m.userId), ...handleOf.keys()]),
  ].filter(Boolean);
  const [users, accounts] = ids.length
    ? await Promise.all([
        User.find({ _id: { $in: ids } })
          .select("_id email")
          .lean(),
        OAuthAccount.find({ userId: { $in: ids } })
          .select("userId provider providerUserId email")
          .lean(),
      ])
    : [[], []];
  const linked = new Map<string, { githubIds: string[]; aliases: string[] }>();
  for (const a of accounts) {
    const entry = linked.get(a.userId) ?? { githubIds: [], aliases: [] };
    if (a.provider === "github" && a.providerUserId) {
      entry.githubIds.push(String(a.providerUserId));
    }
    // A placeholder (`github_<id>@oauth.local`) is nobody's mailbox.
    if (a.email && !a.email.endsWith("@oauth.local")) {
      entry.aliases.push(a.email);
    }
    linked.set(a.userId, entry);
  }
  const people: WorkspacePerson[] = users.map(u => {
    const id = String(u._id);
    return {
      userId: id,
      email: u.email,
      handle: handleOf.get(id),
      ...linked.get(id),
    };
  });
  const memberIds = new Set(members.map(m => m.userId));
  const directory = new PeopleDirectory(
    people,
    workspaceEmailDomains(
      // The domain is the CURRENT members' — not who used to be here.
      people.filter(p => memberIds.has(p.userId)),
      workspace?.settings?.autoJoin?.domains ?? [],
    ),
  );
  cache.set(workspaceId, { at: Date.now(), handles, people: directory });
  return directory;
}

// ---------------------------------------------------------------------------
// GitHub logins → ids (old-style `<login>@users.noreply.github.com`)
// ---------------------------------------------------------------------------

/** A login's id never changes; a miss is retried after an hour. */
const LOGIN_MISS_TTL_MS = 60 * 60_000;
const LOOKUP_TIMEOUT_MS = 1_500;

const loginIds = new Map<string, { id: string | null; at: number }>();
const inflight = new Map<string, Promise<void>>();

async function fetchLoginId(login: string): Promise<void> {
  try {
    const res = await fetch(
      `https://api.github.com/users/${encodeURIComponent(login)}`,
      {
        headers: {
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
      },
    );
    const body = res.ok ? ((await res.json()) as { id?: number }) : null;
    loginIds.set(login, {
      id: body?.id ? String(body.id) : null,
      at: Date.now(),
    });
  } catch (error) {
    loginIds.set(login, { id: null, at: Date.now() });
    logger.warn("GitHub login lookup failed", {
      login,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * GitHub ids for these logins, from a process-wide memo filled by a public
 * API lookup. Only worth asking when someone in the workspace has a linked
 * GitHub sign-in (the id is what matches). A slow GitHub does not hold the
 * page: the lookup is waited for up to its timeout, and a miss is memoized.
 */
export async function githubIdsOfLogins(
  logins: string[],
  people: PeopleDirectory,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (logins.length === 0 || !people.hasGitHubIdentities) return out;
  const pending: Promise<void>[] = [];
  for (const login of logins) {
    const known = loginIds.get(login);
    if (known && (known.id || Date.now() - known.at < LOGIN_MISS_TTL_MS)) {
      continue;
    }
    let p = inflight.get(login);
    if (!p) {
      p = fetchLoginId(login).finally(() => inflight.delete(login));
      inflight.set(login, p);
    }
    pending.push(p);
  }
  if (pending.length) await Promise.all(pending);
  for (const login of logins) {
    const id = loginIds.get(login)?.id;
    if (id) out.set(login, id);
  }
  return out;
}

/** Forget the memos (tests). */
export function invalidatePeopleDirectory(workspaceId?: string): void {
  if (workspaceId) cache.delete(workspaceId);
  else {
    cache.clear();
    loginIds.clear();
  }
}
