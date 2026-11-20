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
  const userName = facts.user?.email || undefined;
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
  return { ...by, kind: "retry", retryOf };
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

/**
 * Fills the display names a request did not carry: a user's email from the
 * user id, an OAuth client's name from its id. Best effort: a lookup failure
 * leaves the ids, which are enough to attribute a run.
 */
export async function withActorNames(actor: DbtRunActor): Promise<DbtRunActor> {
  const next: DbtRunActor = { ...actor };
  try {
    if (next.userId && !next.userName && next.userId !== "agent") {
      const { User } = await import("../database/schema");
      const user = await User.findById(next.userId).select("email").lean();
      if (user?.email) next.userName = user.email;
    }
    if (next.oauthClientId && !next.oauthClientName) {
      const { getOAuthClient } = await import("../auth/mcp-oauth.service");
      const client = await getOAuthClient(next.oauthClientId);
      if (client?.clientName) next.oauthClientName = client.clientName;
    }
  } catch {
    /* ids already attribute the run */
  }
  return compactActor(next);
}

/**
 * The actor as an MCP client may read it: ids and labels. The person shows
 * as `userId`; their email stays out.
 */
export function redactRunActor(
  actor: Partial<DbtRunActor> | null | undefined,
): Omit<DbtRunActor, "userName"> | undefined {
  if (!actor?.kind) return undefined;
  const { userName: _omitted, ...rest } = actor as DbtRunActor;
  void _omitted;
  return compactActor(rest);
}
