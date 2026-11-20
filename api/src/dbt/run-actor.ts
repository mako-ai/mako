/**
 * Who started a dbt run, as one structured field on `dbt_runs.actor`.
 *
 * `trigger` and `triggeredBy` stay as they were ("agent", "scheduler", a user
 * id). They cannot say which API key, MCP client, chat or pushed commit was
 * behind a run, so two incidents could not be attributed. `actor` records it
 * at creation, from what the request context really holds. It never holds a
 * secret: API keys appear by id and label only.
 *
 * Leaf module (mongoose only at load time): the model imports its schema.
 */
import { Schema } from "mongoose";
import { handleFromEmail } from "../apps/user-handles";

export const DBT_RUN_ACTOR_KINDS = [
  "schedule",
  "user",
  "api_key",
  "agent",
  "mcp",
  "deploy_on_push",
  "ci",
  "retry",
] as const;

export type DbtRunActorKind = (typeof DBT_RUN_ACTOR_KINDS)[number];

/** The commit behind a deploy-on-push run. */
export interface DbtRunPushInfo {
  sha: string;
  /** From the commit subject's "(#NNNN)", which is how squash merges read. */
  prNumber?: number;
  /** The commit author: the PR author on a squash merge. */
  prAuthor?: string;
  /** The commit time: the merge time on a squash merge. */
  mergedAt?: Date;
}

export interface DbtRunActor {
  kind: DbtRunActorKind;
  userId?: string;
  /** The person's handle (email local part, as in `users/<handle>/`). Never the email. */
  userName?: string;
  /** Workspace API key: its subdocument id and label. Never the key. */
  apiKeyId?: string;
  apiKeyName?: string;
  /** MCP OAuth client (Claude, Cursor, ...). */
  oauthClientId?: string;
  oauthClientName?: string;
  /** In-app agent chat. */
  chatId?: string;
  /** Desktop agent session on MCP. */
  agentSessionId?: string;
  /** The scheduled job whose tick started the run. */
  jobScheduleId?: string;
  /** For kind "retry": the run that was retried. */
  retryOf?: string;
  /** For kind "retry": how the retry was asked for (user, api_key, mcp). */
  retryOfKind?: DbtRunActorKind;
  push?: DbtRunPushInfo;
}

export const DbtRunActorSchema = new Schema<DbtRunActor>(
  {
    kind: { type: String, enum: DBT_RUN_ACTOR_KINDS, required: true },
    userId: { type: String },
    userName: { type: String },
    apiKeyId: { type: String },
    apiKeyName: { type: String },
    oauthClientId: { type: String },
    oauthClientName: { type: String },
    chatId: { type: String },
    agentSessionId: { type: String },
    jobScheduleId: { type: String },
    retryOf: { type: String },
    retryOfKind: { type: String, enum: DBT_RUN_ACTOR_KINDS },
    push: {
      type: new Schema(
        {
          sha: { type: String, required: true },
          prNumber: { type: Number },
          prAuthor: { type: String },
          mergedAt: { type: Date },
        },
        { _id: false },
      ),
      required: false,
    },
  },
  { _id: false },
);

/** What the auth middleware leaves on a request. */
export interface RequestAuthFacts {
  authType?: "session" | "apiKey" | "mcpOAuth";
  user?: { id?: unknown; email?: string } | null;
  apiKey?: { _id?: unknown; name?: string } | null;
  mcpOAuthClientId?: string;
  mcpAgentSessionId?: string;
}

/**
 * The actor of a REST or MCP request: a signed-in person ("user"), a
 * workspace API key acting for its creator ("api_key"), or an OAuth MCP
 * client ("mcp"). A name the request lacks is filled in by `withActorNames`.
 */
export function actorFromRequest(facts: RequestAuthFacts): DbtRunActor {
  const userId = facts.user?.id != null ? String(facts.user.id) : undefined;
  const userName = facts.user?.email
    ? handleFromEmail(facts.user.email)
    : undefined;
  if (facts.authType === "mcpOAuth") {
    return {
      kind: "mcp",
      userId,
      userName,
      oauthClientId: facts.mcpOAuthClientId,
      agentSessionId: facts.mcpAgentSessionId,
    };
  }
  if (facts.authType === "apiKey") {
    return {
      kind: "api_key",
      userId,
      userName,
      apiKeyId:
        facts.apiKey?._id != null ? String(facts.apiKey._id) : undefined,
      apiKeyName: facts.apiKey?.name,
    };
  }
  return { kind: "user", userId, userName };
}

/** The actor of a run the job scheduler starts on a cron tick. */
export function scheduledRunActor(jobId: string): DbtRunActor {
  return { kind: "schedule", jobScheduleId: jobId };
}

/** The actor of a run that retries `retryOf`, started by `by`. */
export function retryActor(by: DbtRunActor, retryOf: string): DbtRunActor {
  return { ...by, kind: "retry", retryOf, retryOfKind: by.kind };
}

/** "(#1234)" at the end of a squash-merge subject, or "Merge pull request #1234". */
export function prNumberFromSubject(subject: string): number | undefined {
  const match =
    /\(#(\d+)\)\s*$/.exec(subject) ??
    /^Merge pull request #(\d+)\b/.exec(subject);
  return match ? Number(match[1]) : undefined;
}

/** `push` for a commit, from its git log entry. */
export function pushInfoFromCommit(
  sha: string,
  commit?: { author: string; timestamp: number; subject: string },
): DbtRunPushInfo {
  if (!commit) return { sha };
  const prNumber = prNumberFromSubject(commit.subject);
  return {
    sha,
    ...(prNumber !== undefined ? { prNumber } : {}),
    ...(commit.author ? { prAuthor: commit.author } : {}),
    ...(Number.isFinite(commit.timestamp)
      ? { mergedAt: new Date(commit.timestamp) }
      : {}),
  };
}

/** Drops undefined keys so the stored document stays small. */
export function compactActor<T extends object>(actor: T): T {
  return Object.fromEntries(
    Object.entries(actor).filter(([, value]) => value !== undefined),
  ) as T;
}

/** Longest a run waits for display names; past it the run keeps ids only. */
export const ACTOR_NAME_LOOKUP_TIMEOUT_MS = 1000;

async function lookUpNames(actor: DbtRunActor): Promise<DbtRunActor> {
  const next: DbtRunActor = { ...actor };
  if (next.userId && !next.userName && next.userId !== "agent") {
    const { User } = await import("../database/schema");
    const user = await User.findById(next.userId).select("email").lean();
    if (user?.email) next.userName = handleFromEmail(user.email);
  }
  if (next.oauthClientId && !next.oauthClientName) {
    const { getOAuthClient } = await import("../auth/mcp-oauth.service");
    const client = await getOAuthClient(next.oauthClientId);
    if (client?.clientName) next.oauthClientName = client.clientName;
  }
  return next;
}

/**
 * Fills the display names a request did not carry: the user's handle from
 * the user id, an OAuth client's name from its id. Bounded by
 * ACTOR_NAME_LOOKUP_TIMEOUT_MS and best effort: a slow or failed lookup
 * leaves the ids, which are enough to attribute a run, so a run never waits
 * on it for longer than 1 s. Actors with nothing to look up cost no query.
 */
export async function withActorNames(
  actor: DbtRunActor,
  timeoutMs = ACTOR_NAME_LOOKUP_TIMEOUT_MS,
): Promise<DbtRunActor> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const named = await Promise.race([
      lookUpNames(actor),
      new Promise<DbtRunActor>(resolve => {
        timer = setTimeout(() => resolve(actor), timeoutMs);
      }),
    ]);
    return compactActor(named);
  } catch {
    return compactActor(actor);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * The actor as a client may read it, over MCP or REST: ids, labels and the
 * person's handle. A `userName` that holds an email (a run recorded by an
 * older build) is dropped, so an email never leaves the API.
 */
export function redactRunActor(
  actor: Partial<DbtRunActor> | null | undefined,
): DbtRunActor | undefined {
  if (!actor?.kind) return undefined;
  const { userName, ...rest } = actor as DbtRunActor;
  return compactActor({
    ...rest,
    ...(userName && !userName.includes("@") ? { userName } : {}),
  });
}
