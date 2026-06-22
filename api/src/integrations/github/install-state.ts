/**
 * Signed state for the GitHub App install flow (CSRF / IDOR protection).
 *
 * The `state` round-tripped through GitHub's install redirect must not be
 * forgeable by the client: otherwise an attacker can craft
 * `GET /api/github/setup?installation_id=<victim>&state={workspaceId:<mine>}`
 * and bind a victim's installation to their own workspace. We therefore mint a
 * short-lived HMAC-signed token (keyed on SESSION_SECRET) that pins the
 * workspace + the user who started the flow, and verify it on callback.
 *
 * The encoding is URL-safe base64 with no padding, so it can be dropped into
 * the install URL verbatim and survives GitHub's round-trip unchanged.
 */
import { createHmac, timingSafeEqual } from "crypto";

const STATE_TTL_MS = 15 * 60 * 1000;

function stateSecret(): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    throw new Error("SESSION_SECRET is required to sign GitHub install state");
  }
  return secret;
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function sign(body: string): string {
  return b64url(createHmac("sha256", stateSecret()).update(body).digest());
}

export interface InstallStatePayload {
  workspaceId: string;
  userId: string;
  clientUrl?: string;
  exp: number;
}

export function signInstallState(input: {
  workspaceId: string;
  userId: string;
  clientUrl?: string;
}): string {
  const payload: InstallStatePayload = {
    workspaceId: input.workspaceId,
    userId: input.userId,
    clientUrl: input.clientUrl,
    exp: Date.now() + STATE_TTL_MS,
  };
  const body = b64url(JSON.stringify(payload));
  return `${body}.${sign(body)}`;
}

/**
 * Verify a state token. Returns the payload only when the signature is valid
 * and the token has not expired; otherwise `null`.
 */
export function verifyInstallState(
  state: string | undefined,
): InstallStatePayload | null {
  if (!state) return null;
  const dot = state.indexOf(".");
  if (dot <= 0 || dot === state.length - 1) return null;
  const body = state.slice(0, dot);
  const provided = Buffer.from(state.slice(dot + 1));
  const expected = Buffer.from(sign(body));
  if (
    provided.length !== expected.length ||
    !timingSafeEqual(provided, expected)
  ) {
    return null;
  }
  try {
    const payload = JSON.parse(
      Buffer.from(body, "base64").toString("utf8"),
    ) as InstallStatePayload;
    if (
      !payload.workspaceId ||
      !payload.userId ||
      typeof payload.exp !== "number" ||
      Date.now() > payload.exp
    ) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}
