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
}

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

function keyOf(
  secret: string,
  encoding: DeclaredWebhookVerification["secretEncoding"],
): Buffer | null {
  if (encoding === "utf8") return Buffer.from(secret, "utf8");
  if (encoding === "hex") {
    return /^(?:[0-9a-fA-F]{2})+$/.test(secret)
      ? Buffer.from(secret, "hex")
      : null;
  }
  const key = Buffer.from(secret, "base64");
  return key.length > 0 ? key : null;
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
