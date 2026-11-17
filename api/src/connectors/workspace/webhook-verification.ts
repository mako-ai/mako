/**
 * Webhook signatures of workspace connectors, checked in the API.
 *
 * A boxed connector cannot check a signature: the flow's signing secret
 * stays in the API, and no box ever receives it. The connector declares its
 * vendor's scheme as data instead (the SDK's `webhooks.verification`, kept
 * in the spec Mako indexed at push time), and this file runs it. Nothing in
 * a declaration is code: a scheme name, encodings, header names and literal
 * text. Anything this file does not know fails closed.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { WebhookVerificationResult } from "../base/BaseConnector";

export interface DeclaredWebhookVerification {
  scheme: "hmac-sha256";
  secretEncoding: "hex" | "base64" | "utf8";
  signedPayload: string[];
  signatureHeader: string;
  signatureEncoding: "hex" | "base64";
  signaturePrefix?: string;
  /**
   * A header carrying the send time in Unix seconds, and how far from now
   * it may be. Declared together. When declared, a delivery without the
   * header, or outside the window, is refused: a captured delivery cannot
   * be replayed later.
   */
  timestampHeader?: string;
  toleranceSeconds?: number;
}

/** The key a secret decodes to must be at least this long. */
export const MIN_SECRET_BYTES = 16;
/** The widest replay window a declaration may ask for. */
export const MAX_TOLERANCE_SECONDS = 24 * 60 * 60;

const HEADER_NAME = /^[a-z0-9-]{1,64}$/;

/**
 * The declaration in an indexed spec, or null when there is none or it is
 * not one this API can run. The SDK validates the same rules at definition
 * time; this is the API's own check, because a spec is tenant data.
 */
export function declaredWebhookVerification(
  spec: unknown,
): DeclaredWebhookVerification | null {
  const v = (spec as { mako?: { webhooks?: { verification?: unknown } } })?.mako
    ?.webhooks?.verification as Record<string, unknown> | undefined;
  if (!v || typeof v !== "object") return null;
  if (v.scheme !== "hmac-sha256") return null;
  if (!["hex", "base64", "utf8"].includes(v.secretEncoding as string)) {
    return null;
  }
  if (!["hex", "base64"].includes(v.signatureEncoding as string)) return null;
  if (
    typeof v.signatureHeader !== "string" ||
    !HEADER_NAME.test(v.signatureHeader)
  ) {
    return null;
  }
  if (
    v.signaturePrefix !== undefined &&
    (typeof v.signaturePrefix !== "string" || v.signaturePrefix.length > 32)
  ) {
    return null;
  }
  const hasTimestamp = v.timestampHeader !== undefined;
  const hasTolerance = v.toleranceSeconds !== undefined;
  if (hasTimestamp !== hasTolerance) return null;
  if (
    hasTimestamp &&
    (typeof v.timestampHeader !== "string" ||
      !HEADER_NAME.test(v.timestampHeader) ||
      !Number.isSafeInteger(v.toleranceSeconds) ||
      (v.toleranceSeconds as number) < 1 ||
      (v.toleranceSeconds as number) > MAX_TOLERANCE_SECONDS)
  ) {
    return null;
  }
  const parts = v.signedPayload;
  if (!Array.isArray(parts) || parts.length === 0 || parts.length > 8) {
    return null;
  }
  if (!parts.includes("body")) return null;
  for (const part of parts) {
    if (part === "body") continue;
    if (
      typeof part === "string" &&
      part.startsWith("header:") &&
      HEADER_NAME.test(part.slice("header:".length))
    ) {
      continue;
    }
    if (
      typeof part === "string" &&
      part.startsWith("literal:") &&
      part.length <= 72
    ) {
      continue;
    }
    return null;
  }
  return {
    scheme: "hmac-sha256",
    secretEncoding:
      v.secretEncoding as DeclaredWebhookVerification["secretEncoding"],
    signedPayload: [...(parts as string[])],
    signatureHeader: v.signatureHeader,
    signatureEncoding:
      v.signatureEncoding as DeclaredWebhookVerification["signatureEncoding"],
    ...(typeof v.signaturePrefix === "string"
      ? { signaturePrefix: v.signaturePrefix }
      : {}),
    ...(hasTimestamp
      ? {
          timestampHeader: v.timestampHeader as string,
          toleranceSeconds: v.toleranceSeconds as number,
        }
      : {}),
  };
}

function header(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const value =
    headers[name] ??
    Object.entries(headers).find(([key]) => key.toLowerCase() === name)?.[1];
  if (Array.isArray(value)) return value.length === 1 ? value[0] : undefined;
  return typeof value === "string" ? value : undefined;
}

/**
 * The HMAC key, decoded strictly. A secret that does not round-trip in its
 * encoding, or decodes to fewer than MIN_SECRET_BYTES, is no key: Node's
 * lenient base64 would turn `"ab=" + junk` into a 1-byte key.
 */
export function keyOf(
  secret: string,
  encoding: DeclaredWebhookVerification["secretEncoding"],
): Buffer | null {
  let key: Buffer;
  if (encoding === "utf8") {
    key = Buffer.from(secret, "utf8");
  } else if (encoding === "hex") {
    if (!/^(?:[0-9a-fA-F]{2})+$/.test(secret)) return null;
    key = Buffer.from(secret, "hex");
  } else {
    if (secret.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(secret)) {
      return null;
    }
    key = Buffer.from(secret, "base64");
    if (key.toString("base64") !== secret) return null;
  }
  return key.length >= MIN_SECRET_BYTES ? key : null;
}

/**
 * Check one delivery against a declaration with the flow's secret. Valid
 * means the signature matched in constant time and the body is JSON.
 */
export function verifyDeclaredWebhook(
  declaration: DeclaredWebhookVerification,
  options: {
    payload: string;
    headers: Record<string, string | string[] | undefined>;
    secret?: string;
    /** The time now, for the replay window. */
    now?: Date;
  },
): WebhookVerificationResult {
  const { payload, headers, secret } = options;
  if (!secret) return { valid: false, error: "Missing webhook secret" };
  const key = keyOf(secret, declaration.secretEncoding);
  if (!key) return { valid: false, error: "The webhook secret is malformed" };

  const presented = header(headers, declaration.signatureHeader);
  if (!presented) {
    return {
      valid: false,
      error: `Missing ${declaration.signatureHeader} header`,
    };
  }
  if (declaration.timestampHeader) {
    const sent = header(headers, declaration.timestampHeader);
    if (!sent || !/^\d{1,12}$/.test(sent)) {
      return {
        valid: false,
        error: `Missing or malformed ${declaration.timestampHeader} header`,
      };
    }
    const nowSeconds = (options.now ?? new Date()).getTime() / 1000;
    if (
      Math.abs(nowSeconds - Number(sent)) >
      (declaration.toleranceSeconds as number)
    ) {
      return { valid: false, error: "The delivery is outside its time window" };
    }
  }
  const prefix = declaration.signaturePrefix ?? "";
  if (!presented.startsWith(prefix)) {
    return { valid: false, error: "Invalid signature" };
  }

  const hmac = createHmac("sha256", key);
  for (const part of declaration.signedPayload) {
    if (part === "body") {
      hmac.update(payload);
    } else if (part.startsWith("header:")) {
      const name = part.slice("header:".length);
      const value = header(headers, name);
      if (value === undefined) {
        return { valid: false, error: `Missing ${name} header` };
      }
      hmac.update(value);
    } else {
      hmac.update(part.slice("literal:".length));
    }
  }
  const expected = Buffer.from(
    hmac.digest(declaration.signatureEncoding),
    "utf8",
  );
  const given = Buffer.from(presented.slice(prefix.length), "utf8");
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
    return { valid: false, error: "Invalid signature" };
  }
  try {
    return { valid: true, event: JSON.parse(payload) };
  } catch {
    return { valid: false, error: "Invalid JSON payload" };
  }
}
