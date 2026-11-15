/**
 * The HMAC token format the apps services share: `<base64url JSON>.<sig>`,
 * where sig is HMAC-SHA256 over the body with SESSION_SECRET (or
 * ENCRYPTION_KEY). The git token (`mgt_…`, git-token.service.ts) and the
 * published-app token (`pub_…`, preview.service.ts) put their own prefix in
 * front and their own payload inside.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export const MISSING_TOKEN_SECRET =
  "Missing HMAC secret: set SESSION_SECRET or ENCRYPTION_KEY";

/** The signing secret, or undefined when neither variable is set. */
export function tokenSecret(): string | undefined {
  return process.env.SESSION_SECRET || process.env.ENCRYPTION_KEY || undefined;
}

export function signTokenBody(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body).digest("base64url");
}

/** `<body>.<signature>` for a JSON payload. */
export function signTokenPayload(payload: object, secret: string): string {
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString(
    "base64url",
  );
  return `${body}.${signTokenBody(body, secret)}`;
}

/**
 * The body of a `<body>.<signature>` string whose signature checks out, or
 * why not. Constant-time; never throws.
 */
export function verifiedTokenBody(
  signed: string,
  secret: string,
): { body: string } | { error: "malformed" | "signature" } {
  const [body, signature] = signed.split(".");
  if (!body || !signature) return { error: "malformed" };
  const expected = Buffer.from(signTokenBody(body, secret), "utf8");
  const actual = Buffer.from(signature, "utf8");
  // Length-check first: timingSafeEqual THROWS on a length mismatch rather
  // than returning false, which would turn a forged token into a 500.
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    return { error: "signature" };
  }
  return { body };
}

/** The JSON a verified body carries (throws on a body that is not JSON). */
export function decodeTokenBody<T>(body: string): T {
  return JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as T;
}
