/**
 * Git tokens — short-lived, workspace-scoped credentials a sandbox uses to
 * push and pull.
 *
 * Same shape as the notebook kernel token (`services/kernel-token.service.ts`):
 * an HMAC-signed self-contained blob, so the git endpoint verifies it without
 * a database lookup.
 *
 * This RELAXES an earlier invariant, deliberately and with eyes open. Apps
 * used to state that the sandbox never holds a git credential, and paid for it
 * with a private transfer format (bundles) plus a shadow-commit layer to
 * decide what to transfer. The cost was not the code — it was that the box
 * stopped being a normal machine. `git push` did nothing, so neither did any
 * tool that expects a normal machine, up to and including running a coding
 * agent inside the sandbox.
 *
 * What replaces the invariant is scope. The token grants exactly one thing:
 * fetch and push on ONE workspace's repository, through Mako's own endpoint,
 * which still applies its own rules on receive. It carries no database
 * credential, reaches no other workspace, and expires. That is the same trade
 * every hosted dev environment makes, and it is the honest one.
 */
import {
  MISSING_TOKEN_SECRET,
  decodeTokenBody,
  signTokenPayload,
  tokenSecret,
  verifiedTokenBody,
} from "./signed-token";

const TOKEN_PREFIX = "mgt_"; // mako git token

/**
 * Long enough to cover a working session without a mid-`push` expiry, short
 * enough that a leaked token is not a standing grant. Every touch of the
 * sandbox rewrites it, so an active box never reaches the deadline.
 */
const DEFAULT_TTL_SECONDS = 12 * 60 * 60;

export interface GitTokenPayload {
  v: 1;
  /** Workspace whose repository this may read and write. */
  wsId: string;
  /** Actor the pushes are attributed to. */
  userId: string;
  /**
   * The actor's email, when known at mint time. The git endpoint enforces that
   * a pushed commit is authored by this address (see the pre-receive hook),
   * which is how "who changed which files" stays trustworthy without the
   * endpoint reaching into the database. Optional: a token minted for an actor
   * whose email could not be resolved (a system actor, a lookup failure) omits
   * it, and the endpoint then falls back to attribution-without-enforcement.
   */
  email?: string;
  scope: "git";
  iat: number;
  exp: number;
}

export class GitTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitTokenError";
  }
}

function resolveSecret(): string {
  const secret = tokenSecret();
  if (!secret) throw new GitTokenError(MISSING_TOKEN_SECRET);
  return secret;
}

export function mintGitToken(input: {
  workspaceId: string;
  userId: string;
  /** The actor's email, bound into the token for authorship enforcement. */
  email?: string;
  ttlSeconds?: number;
}): string {
  const now = Math.floor(Date.now() / 1000);
  const payload: GitTokenPayload = {
    v: 1,
    wsId: input.workspaceId,
    userId: input.userId,
    ...(input.email ? { email: input.email } : {}),
    scope: "git",
    iat: now,
    exp: now + (input.ttlSeconds ?? DEFAULT_TTL_SECONDS),
  };
  return `${TOKEN_PREFIX}${signTokenPayload(payload, resolveSecret())}`;
}

export function verifyGitToken(token: string): GitTokenPayload {
  if (!token.startsWith(TOKEN_PREFIX)) {
    throw new GitTokenError("Not a git token");
  }
  const rest = token.slice(TOKEN_PREFIX.length);
  // Malformed before the secret: a token with no signature part says so
  // even on a host with no secret configured.
  const [head, tail] = rest.split(".");
  if (!head || !tail) throw new GitTokenError("Malformed git token");
  const verified = verifiedTokenBody(rest, resolveSecret());
  if ("error" in verified) {
    throw new GitTokenError("Bad git token signature");
  }
  const payload = decodeTokenBody<GitTokenPayload>(verified.body);
  if (payload.v !== 1 || payload.scope !== "git") {
    throw new GitTokenError("Unsupported git token");
  }
  if (payload.exp <= Math.floor(Date.now() / 1000)) {
    throw new GitTokenError("Git token expired");
  }
  return payload;
}
