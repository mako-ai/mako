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
import {
  createHmac,
  createPublicKey,
  timingSafeEqual,
  verify as verifySignature,
  type KeyObject,
} from "node:crypto";
import type { WebhookVerificationResult } from "../base/BaseConnector";

export type DeclaredWebhookVerification =
  | DeclaredHmacVerification
  | DeclaredStripeV1Verification
  | DeclaredSharedSecretVerification
  | DeclaredRsaVerification;

/**
 * A vendor that signs the raw body with its own RSA keys (Wise). No secret:
 * the connector declares the vendor's public keys, and a signature any one
 * of them verifies is valid. A declared `testNotification` (the vendor's
 * unsigned test ping) is answered without a signature and stored under its
 * `eventType` with no payload, so nothing it says reaches a table.
 */
export interface DeclaredRsaVerification {
  scheme: "rsa-sha256";
  publicKeys: string[];
  signatureHeader: string;
  signatureEncoding: "hex" | "base64";
  testNotification?: { header: string; value: string; eventType: string };
}

/**
 * A vendor that sends the secret itself in a header (Claap). Compared in
 * constant time with the flow's secret, which must be MIN_SECRET_BYTES long.
 */
export interface DeclaredSharedSecretVerification {
  scheme: "shared-secret";
  secretHeader: string;
}

/**
 * Stripe's scheme: one header, `t=<unix seconds>,v1=<hex>[,v1=<hex>...]`.
 * Each `v1` is an HMAC-SHA256 of `<t>.<raw body>` under the secret's UTF-8
 * bytes, as `stripe.webhooks.constructEvent` checks it. The timestamp is
 * always signed, and always bounded by `toleranceSeconds`.
 */
export interface DeclaredStripeV1Verification {
  scheme: "stripe-v1";
  signatureHeader: string;
  secretEncoding: "utf8";
  toleranceSeconds: number;
}

export interface DeclaredHmacVerification {
  scheme: "hmac-sha256";
  secretEncoding: "hex" | "base64" | "utf8";
  signedPayload: string[];
  signatureHeader: string;
  signatureEncoding: "hex" | "base64";
  signaturePrefix?: string;
  /** A query parameter carrying the signature, read before the header. */
  signatureQuery?: string;
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
const QUERY_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const BODY_PATH = /^[A-Za-z0-9_]{1,64}(\.[A-Za-z0-9_]{1,64}){0,7}$/;

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
  if (v.scheme === "stripe-v1") return declaredStripeV1(v);
  if (v.scheme === "rsa-sha256") return declaredRsa(v);
  if (v.scheme === "shared-secret") {
    return typeof v.secretHeader === "string" &&
      HEADER_NAME.test(v.secretHeader)
      ? { scheme: "shared-secret", secretHeader: v.secretHeader }
      : null;
  }
  if (v.scheme !== "hmac-sha256") return null;
  if (
    v.signatureQuery !== undefined &&
    (typeof v.signatureQuery !== "string" || !QUERY_NAME.test(v.signatureQuery))
  ) {
    return null;
  }
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
  // A window on a timestamp the signature does not cover is no window: a
  // replay would carry an old body with a fresh header. The timestamp must
  // be signed.
  if (hasTimestamp && !parts.includes(`header:${v.timestampHeader}`)) {
    return null;
  }
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
      v.secretEncoding as DeclaredHmacVerification["secretEncoding"],
    signedPayload: [...(parts as string[])],
    signatureHeader: v.signatureHeader,
    signatureEncoding:
      v.signatureEncoding as DeclaredHmacVerification["signatureEncoding"],
    ...(typeof v.signaturePrefix === "string"
      ? { signaturePrefix: v.signaturePrefix }
      : {}),
    ...(typeof v.signatureQuery === "string"
      ? { signatureQuery: v.signatureQuery }
      : {}),
    ...(hasTimestamp
      ? {
          timestampHeader: v.timestampHeader as string,
          toleranceSeconds: v.toleranceSeconds as number,
        }
      : {}),
  };
}

const STRIPE_V1_KEYS = new Set([
  "scheme",
  "signatureHeader",
  "secretEncoding",
  "toleranceSeconds",
]);

/** A stripe-v1 declaration, exactly its four keys, or null. */
const RSA_KEYS = new Set([
  "scheme",
  "publicKeys",
  "signatureHeader",
  "signatureEncoding",
  "testNotification",
]);
const EVENT_TYPE = /^[A-Za-z0-9_.:#-]{1,64}$/;
const MAX_PUBLIC_KEY_LENGTH = 4096;

/** An RSA public key from PEM (SPKI), or null. */
function rsaPublicKey(pem: unknown): KeyObject | null {
  if (typeof pem !== "string" || pem.length > MAX_PUBLIC_KEY_LENGTH) {
    return null;
  }
  if (!pem.trim().startsWith("-----BEGIN PUBLIC KEY-----")) return null;
  try {
    const key = createPublicKey({ key: pem, format: "pem" });
    return key.asymmetricKeyType === "rsa" ? key : null;
  } catch {
    return null;
  }
}

function declaredRsa(
  v: Record<string, unknown>,
): DeclaredRsaVerification | null {
  if (Object.keys(v).some(key => !RSA_KEYS.has(key))) return null;
  if (
    !Array.isArray(v.publicKeys) ||
    v.publicKeys.length === 0 ||
    v.publicKeys.length > 4 ||
    v.publicKeys.some(key => !rsaPublicKey(key))
  ) {
    return null;
  }
  if (
    typeof v.signatureHeader !== "string" ||
    !HEADER_NAME.test(v.signatureHeader)
  ) {
    return null;
  }
  if (!["hex", "base64"].includes(v.signatureEncoding as string)) return null;
  let testNotification: DeclaredRsaVerification["testNotification"];
  if (v.testNotification !== undefined) {
    const t = v.testNotification as Record<string, unknown> | null;
    if (
      !t ||
      typeof t !== "object" ||
      typeof t.header !== "string" ||
      !HEADER_NAME.test(t.header) ||
      typeof t.value !== "string" ||
      t.value.length === 0 ||
      t.value.length > 64 ||
      typeof t.eventType !== "string" ||
      !EVENT_TYPE.test(t.eventType)
    ) {
      return null;
    }
    testNotification = {
      header: t.header,
      value: t.value,
      eventType: t.eventType,
    };
  }
  return {
    scheme: "rsa-sha256",
    publicKeys: [...(v.publicKeys as string[])],
    signatureHeader: v.signatureHeader,
    signatureEncoding: v.signatureEncoding as "hex" | "base64",
    ...(testNotification ? { testNotification } : {}),
  };
}

/**
 * An RSA-SHA256 signature of the raw body, by any declared key, or the
 * declared test ping (answered whatever its signature, with no payload).
 */
function verifyRsa(
  declaration: DeclaredRsaVerification,
  options: {
    payload: string;
    headers: Record<string, string | string[] | undefined>;
  },
): WebhookVerificationResult {
  const { payload, headers } = options;
  const test = declaration.testNotification;
  if (
    test &&
    header(headers, test.header)?.trim().toLowerCase() ===
      test.value.toLowerCase()
  ) {
    return { valid: true, event: { type: test.eventType } };
  }
  const presented = header(headers, declaration.signatureHeader);
  if (!presented) {
    return {
      valid: false,
      error: `Missing ${declaration.signatureHeader} header`,
    };
  }
  const signature = Buffer.from(presented, declaration.signatureEncoding);
  let matched = false;
  if (signature.length > 0) {
    for (const pem of declaration.publicKeys) {
      const key = rsaPublicKey(pem);
      if (!key) continue;
      try {
        if (
          verifySignature(
            "sha256",
            Buffer.from(payload, "utf8"),
            key,
            signature,
          )
        ) {
          matched = true;
          break;
        }
      } catch {
        // A signature this key cannot read: try the next key.
      }
    }
  }
  if (!matched) return { valid: false, error: "Invalid signature" };
  try {
    return { valid: true, event: JSON.parse(payload) };
  } catch {
    return { valid: false, error: "Invalid JSON payload" };
  }
}

function declaredStripeV1(
  v: Record<string, unknown>,
): DeclaredStripeV1Verification | null {
  if (Object.keys(v).some(key => !STRIPE_V1_KEYS.has(key))) return null;
  if (
    typeof v.signatureHeader !== "string" ||
    !HEADER_NAME.test(v.signatureHeader)
  ) {
    return null;
  }
  if (v.secretEncoding !== "utf8") return null;
  if (
    !Number.isSafeInteger(v.toleranceSeconds) ||
    (v.toleranceSeconds as number) < 1 ||
    (v.toleranceSeconds as number) > MAX_TOLERANCE_SECONDS
  ) {
    return null;
  }
  return {
    scheme: "stripe-v1",
    signatureHeader: v.signatureHeader,
    secretEncoding: "utf8",
    toleranceSeconds: v.toleranceSeconds as number,
  };
}

/** A Stripe signature header: its one `t`, and every `v1`. */
function parseStripeSignatureHeader(
  value: string,
): { timestamp: string; signatures: string[] } | null {
  let timestamp: string | undefined;
  const signatures: string[] = [];
  for (const item of value.split(",")) {
    const at = item.indexOf("=");
    if (at <= 0) continue;
    const key = item.slice(0, at).trim();
    const val = item.slice(at + 1).trim();
    if (key === "t") {
      // Two timestamps make the signed one ambiguous: refused.
      if (timestamp !== undefined) return null;
      timestamp = val;
    } else if (key === "v1") {
      signatures.push(val);
    }
  }
  if (timestamp === undefined || signatures.length === 0) return null;
  // At most 16 signatures: Stripe sends one per active secret (two while a
  // secret rolls). More is not a Stripe delivery.
  if (signatures.length > 16) return null;
  return { timestamp, signatures };
}

function verifyStripeV1(
  declaration: DeclaredStripeV1Verification,
  options: {
    payload: string;
    headers: Record<string, string | string[] | undefined>;
    secret?: string;
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
  const parsed = parseStripeSignatureHeader(presented);
  if (!parsed || !/^\d{1,12}$/.test(parsed.timestamp)) {
    return {
      valid: false,
      error: `Malformed ${declaration.signatureHeader} header`,
    };
  }
  const nowSeconds = (options.now ?? new Date()).getTime() / 1000;
  if (
    Math.abs(nowSeconds - Number(parsed.timestamp)) >
    declaration.toleranceSeconds
  ) {
    return { valid: false, error: "The delivery is outside its time window" };
  }
  const expected = Buffer.from(
    createHmac("sha256", key)
      .update(`${parsed.timestamp}.`)
      .update(payload)
      .digest("hex"),
    "utf8",
  );
  const matched = parsed.signatures.some(signature => {
    const given = Buffer.from(signature, "utf8");
    return given.length === expected.length && timingSafeEqual(expected, given);
  });
  if (!matched) return { valid: false, error: "Invalid signature" };
  try {
    return { valid: true, event: JSON.parse(payload) };
  } catch {
    return { valid: false, error: "Invalid JSON payload" };
  }
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
  encoding: DeclaredHmacVerification["secretEncoding"],
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
    /** The request's query string, for a signature sent as a parameter. */
    query?: Record<string, string | string[] | undefined>;
    secret?: string;
    /** The time now, for the replay window. */
    now?: Date;
  },
): WebhookVerificationResult {
  if (declaration.scheme === "stripe-v1") {
    return verifyStripeV1(declaration, options);
  }
  if (declaration.scheme === "rsa-sha256") {
    return verifyRsa(declaration, options);
  }
  const { payload, headers, secret } = options;
  if (!secret) return { valid: false, error: "Missing webhook secret" };
  if (declaration.scheme === "shared-secret") {
    return verifySharedSecret(declaration, { payload, headers, secret });
  }
  const key = keyOf(secret, declaration.secretEncoding);
  if (!key) return { valid: false, error: "The webhook secret is malformed" };

  const fromQuery = declaration.signatureQuery
    ? single(options.query?.[declaration.signatureQuery])
    : undefined;
  const presented = fromQuery || header(headers, declaration.signatureHeader);
  if (!presented) {
    return {
      valid: false,
      error: declaration.signatureQuery
        ? `Missing ${declaration.signatureQuery} parameter or ${declaration.signatureHeader} header`
        : `Missing ${declaration.signatureHeader} header`,
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
  // Hex compares case-insensitively, as the in-process checks do
  // (timingSafeEqualHex); base64 is case-sensitive.
  const fold = (text: string) =>
    declaration.signatureEncoding === "hex" ? text.toLowerCase() : text;
  const expected = Buffer.from(
    fold(hmac.digest(declaration.signatureEncoding)),
    "utf8",
  );
  const given = Buffer.from(fold(presented.slice(prefix.length)), "utf8");
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
    return { valid: false, error: "Invalid signature" };
  }
  try {
    return { valid: true, event: JSON.parse(payload) };
  } catch {
    return { valid: false, error: "Invalid JSON payload" };
  }
}

function single(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value.length > 0 ? value[0] : undefined;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * The secret itself in a header, compared in constant time. The flow's
 * secret must be at least MIN_SECRET_BYTES long: a short one is guessable.
 */
function verifySharedSecret(
  declaration: DeclaredSharedSecretVerification,
  options: {
    payload: string;
    headers: Record<string, string | string[] | undefined>;
    secret: string;
  },
): WebhookVerificationResult {
  const expected = Buffer.from(options.secret, "utf8");
  if (expected.length < MIN_SECRET_BYTES) {
    return { valid: false, error: "The webhook secret is malformed" };
  }
  const presented = header(options.headers, declaration.secretHeader);
  if (!presented) {
    return {
      valid: false,
      error: `Missing ${declaration.secretHeader} header`,
    };
  }
  const given = Buffer.from(presented, "utf8");
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
    return { valid: false, error: "Invalid webhook secret" };
  }
  try {
    return { valid: true, event: JSON.parse(options.payload) };
  } catch {
    return { valid: false, error: "Invalid JSON payload" };
  }
}

/**
 * Where the connector says a delivery's event id and type sit in its body
 * (the SDK's `webhooks.eventIdPath` / `eventTypePath`), from the indexed
 * spec. Paths that are not plain dotted names are ignored.
 */
export function declaredWebhookIdentity(spec: unknown): {
  /** One path, or several whose values join with ":". */
  eventIdPath?: string | string[];
  /** A header with the vendor's delivery id, read before the body. */
  eventIdHeader?: string;
  eventTypePath?: string;
} {
  const w = (spec as { mako?: { webhooks?: Record<string, unknown> } })?.mako
    ?.webhooks;
  const ok = (value: unknown): value is string =>
    typeof value === "string" && BODY_PATH.test(value);
  const idPath = w?.eventIdPath;
  const idPaths =
    Array.isArray(idPath) &&
    idPath.length > 0 &&
    idPath.length <= 4 &&
    idPath.every(ok)
      ? (idPath as string[])
      : undefined;
  return {
    ...(ok(idPath) ? { eventIdPath: idPath } : {}),
    ...(idPaths ? { eventIdPath: [...idPaths] } : {}),
    ...(typeof w?.eventIdHeader === "string" &&
    HEADER_NAME.test(w.eventIdHeader)
      ? { eventIdHeader: w.eventIdHeader }
      : {}),
    ...(ok(w?.eventTypePath) ? { eventTypePath: w.eventTypePath } : {}),
  };
}

/**
 * A delivery's event id as declared: the id header's value, else the body
 * path's value, else every listed path's value joined with ":" (all of
 * them present). Undefined when the declaration finds nothing.
 */
export function declaredEventId(
  identity: ReturnType<typeof declaredWebhookIdentity>,
  body: unknown,
  headers: Record<string, string | string[] | undefined> = {},
): string | undefined {
  if (identity.eventIdHeader) {
    const value = header(headers, identity.eventIdHeader);
    if (value && value.length <= 512) return value;
  }
  const paths = identity.eventIdPath;
  if (typeof paths === "string") return valueAtPath(body, paths);
  if (Array.isArray(paths)) {
    const values = paths.map(path => valueAtPath(body, path));
    if (values.every(v => v !== undefined)) {
      return values.join(":").slice(0, 512);
    }
  }
  return undefined;
}

/** The string or number at a dotted path of a parsed body, as a string. */
export function valueAtPath(body: unknown, path: string): string | undefined {
  let node: unknown = body;
  for (const part of path.split(".")) {
    if (node === null || typeof node !== "object") return undefined;
    if (!Object.prototype.hasOwnProperty.call(node, part)) return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  if (typeof node === "string" && node.length > 0 && node.length <= 512) {
    return node;
  }
  return typeof node === "number" && Number.isFinite(node)
    ? String(node)
    : undefined;
}
