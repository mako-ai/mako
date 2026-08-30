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
import { createHmac, timingSafeEqual } from "crypto";

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
  const secret = process.env.SESSION_SECRET || process.env.ENCRYPTION_KEY;
  if (!secret) {
    throw new GitTokenError(
      "Missing HMAC secret: set SESSION_SECRET or ENCRYPTION_KEY",
    );
  }
  return secret;
}

function sign(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body).digest("base64url");
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
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString(
    "base64url",
  );
  return `${TOKEN_PREFIX}${body}.${sign(body, resolveSecret())}`;
}

export function verifyGitToken(token: string): GitTokenPayload {
  if (!token.startsWith(TOKEN_PREFIX)) {
    throw new GitTokenError("Not a git token");
  }
  const [body, signature] = token.slice(TOKEN_PREFIX.length).split(".");
  if (!body || !signature) throw new GitTokenError("Malformed git token");

  const expected = Buffer.from(sign(body, resolveSecret()), "utf8");
  const actual = Buffer.from(signature, "utf8");
  // Length-check first: timingSafeEqual THROWS on a length mismatch rather
  // than returning false, which would turn a forged token into a 500.
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new GitTokenError("Bad git token signature");
  }

  const payload = JSON.parse(
    Buffer.from(body, "base64url").toString("utf8"),
  ) as GitTokenPayload;
  if (payload.v !== 1 || payload.scope !== "git") {
    throw new GitTokenError("Unsupported git token");
  }
  if (payload.exp <= Math.floor(Date.now() / 1000)) {
    throw new GitTokenError("Git token expired");
  }
  return payload;
}
