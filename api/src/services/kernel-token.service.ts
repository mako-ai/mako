/**
 * Kernel tokens — short-lived, read-only, workspace-scoped bearer credentials
 * minted for a notebook kernel session.
 *
 * A notebook kernel runs untrusted user/agent code in an isolated sandbox and
 * must never hold a database credential or a long-lived workspace API key. The
 * orchestrator mints one of these tokens per session and injects it into the
 * pod; the `mako` Python SDK sends it to `POST /workspaces/:id/notebook/read`,
 * which is the only surface it can reach.
 *
 * The token is a compact HMAC-signed blob (`mnk_<base64url(payload)>.<sig>`),
 * self-contained so the read endpoint verifies it without a DB lookup. The HMAC
 * secret follows the same convention as the OAuth state signer
 * (`api/src/auth/oauth-proxy.ts`): `SESSION_SECRET` or `ENCRYPTION_KEY`, with an
 * optional dedicated `NOTEBOOK_KERNEL_SECRET` override.
 */
import { createHmac, timingSafeEqual } from "crypto";

const TOKEN_PREFIX = "mnk_"; // mako notebook kernel
const DEFAULT_TTL_SECONDS = 15 * 60;

export interface KernelTokenPayload {
  /** Payload schema version, for forward-compatible rotation. */
  v: 1;
  /** Workspace the token is scoped to (Mongo ObjectId string). */
  wsId: string;
  /** User the session acts on behalf of (for audit). */
  userId: string;
  /** Notebook the session belongs to, when bound to one. */
  notebookId?: string;
  /** Only read access exists today; present so the scope is explicit + checkable. */
  scope: "read";
  /** Issued-at (unix seconds). */
  iat: number;
  /** Expiry (unix seconds). */
  exp: number;
}

export class KernelTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KernelTokenError";
  }
}

function resolveSecret(): string {
  const secret =
    process.env.NOTEBOOK_KERNEL_SECRET ||
    process.env.SESSION_SECRET ||
    process.env.ENCRYPTION_KEY;
  if (!secret) {
    throw new KernelTokenError(
      "Missing HMAC secret: set NOTEBOOK_KERNEL_SECRET, SESSION_SECRET, or ENCRYPTION_KEY",
    );
  }
  return secret;
}

function sign(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body).digest("base64url");
}

/** True if the bearer value looks like a kernel token (before verifying it). */
export function isKernelToken(token: string): boolean {
  return token.startsWith(TOKEN_PREFIX);
}

export function mintKernelToken(input: {
  workspaceId: string;
  userId: string;
  notebookId?: string;
  ttlSeconds?: number;
  /** Injectable clock (ms) for tests. */
  nowMs?: number;
}): string {
  const secret = resolveSecret();
  const nowSec = Math.floor((input.nowMs ?? Date.now()) / 1000);
  const ttl = Math.max(1, Math.floor(input.ttlSeconds ?? DEFAULT_TTL_SECONDS));
  const payload: KernelTokenPayload = {
    v: 1,
    wsId: input.workspaceId,
    userId: input.userId,
    notebookId: input.notebookId,
    scope: "read",
    iat: nowSec,
    exp: nowSec + ttl,
  };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${TOKEN_PREFIX}${body}.${sign(body, secret)}`;
}

export function verifyKernelToken(
  token: string,
  opts?: { nowMs?: number },
): KernelTokenPayload {
  const secret = resolveSecret();
  if (!token.startsWith(TOKEN_PREFIX)) {
    throw new KernelTokenError("Not a kernel token");
  }
  const raw = token.slice(TOKEN_PREFIX.length);
  const dot = raw.indexOf(".");
  if (dot <= 0 || dot === raw.length - 1) {
    throw new KernelTokenError("Malformed kernel token");
  }
  const body = raw.slice(0, dot);
  const providedSig = raw.slice(dot + 1);
  const expectedSig = sign(body, secret);

  // Constant-time comparison; length guard first so timingSafeEqual never throws.
  const provided = Buffer.from(providedSig);
  const expected = Buffer.from(expectedSig);
  if (
    provided.length !== expected.length ||
    !timingSafeEqual(provided, expected)
  ) {
    throw new KernelTokenError("Invalid kernel token signature");
  }

  let payload: KernelTokenPayload;
  try {
    payload = JSON.parse(
      Buffer.from(body, "base64url").toString("utf8"),
    ) as KernelTokenPayload;
  } catch {
    throw new KernelTokenError("Malformed kernel token payload");
  }

  if (
    payload.v !== 1 ||
    payload.scope !== "read" ||
    typeof payload.wsId !== "string" ||
    !payload.wsId ||
    typeof payload.userId !== "string" ||
    !payload.userId ||
    typeof payload.exp !== "number"
  ) {
    throw new KernelTokenError("Invalid kernel token payload");
  }

  const nowSec = Math.floor((opts?.nowMs ?? Date.now()) / 1000);
  if (payload.exp <= nowSec) {
    throw new KernelTokenError("Kernel token expired");
  }

  return payload;
}
