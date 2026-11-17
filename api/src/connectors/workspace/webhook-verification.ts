/**
 * Webhook signatures of workspace connectors, checked in the API.
 *
 * A boxed connector cannot check a signature: the flow's signing secret
 * stays in the API, and no box ever receives it. The connector declares its
 * vendor's scheme as data instead (the SDK's `webhooks.verification`, kept
 * in the spec Mako indexed at push time), and this file runs it. Nothing in
 * a declaration is code: a scheme name, encodings, header and key names,
 * literal text and public keys. Anything this file does not know fails
 * closed.
 *
 * Two schemes: `hmac-sha256` under the flow's secret (Close, Calendly), and
 * `rsa-sha256` against public keys the connector declares (Wise), which
 * needs no secret. A signature header may hold `key=value` pairs
 * (`t=...,v1=...`, Calendly and Stripe): `signatureParam` names the
 * signature and `timestampParam` the send time.
 *
 * `declaredWebhookDelivery` reads where a delivery's event id and type are
 * (the SDK's `webhooks.delivery`), so a stored event is keyed as the
 * in-process connector keys it.
 */
import {
  createHmac,
  createPublicKey,
  randomUUID,
  timingSafeEqual,
  verify as verifySignature,
  type KeyObject,
} from "node:crypto";
import type { WebhookVerificationResult } from "../base/BaseConnector";

export interface DeclaredWebhookVerification {
  scheme: "hmac-sha256" | "rsa-sha256";
  /** HMAC only. */
  secretEncoding?: "hex" | "base64" | "utf8";
  /** RSA only: PEM public keys, any one of which may verify. */
  publicKeys?: string[];
  signedPayload: string[];
  signatureHeader: string;
  signatureEncoding: "hex" | "base64";
  signaturePrefix?: string;
  /** The signature header is `k=v,k=v`; the signature is this key's value. */
  signatureParam?: string;
  /**
   * A header (or a key of the signature header) carrying the send time in
   * Unix seconds, and how far from now it may be. When declared, a
   * delivery without it, or outside the window, is refused: a captured
   * delivery cannot be replayed later.
   */
  timestampHeader?: string;
  timestampParam?: string;
  toleranceSeconds?: number;
  /** The vendor's unsigned test ping, stored under `eventType`. */
  testNotification?: { header: string; value: string; eventType: string };
}

export interface DeclaredWebhookDelivery {
  idHeader?: string;
  idFields?: string[];
  typeField?: string;
}

/** The key a secret decodes to must be at least this long. */
export const MIN_SECRET_BYTES = 16;
/** The widest replay window a declaration may ask for. */
export const MAX_TOLERANCE_SECONDS = 24 * 60 * 60;

const HEADER_NAME = /^[a-z0-9-]{1,64}$/;
const PARAM_NAME = /^[A-Za-z0-9_-]{1,32}$/;
const EVENT_TYPE = /^[A-Za-z0-9_.:#-]{1,64}$/;
const FIELD_PATH = /^[A-Za-z0-9_-]{1,64}(\.[A-Za-z0-9_-]{1,64}){0,4}$/;
const MAX_PUBLIC_KEYS = 4;
const MAX_PUBLIC_KEY_LENGTH = 4096;

/** An RSA public key from PEM, or null. Only RSA SPKI keys are taken. */
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
  if (v.scheme !== "hmac-sha256" && v.scheme !== "rsa-sha256") return null;
  const rsa = v.scheme === "rsa-sha256";
  let publicKeys: string[] | undefined;
  if (rsa) {
    if (v.secretEncoding !== undefined) return null;
    if (
      !Array.isArray(v.publicKeys) ||
      v.publicKeys.length === 0 ||
      v.publicKeys.length > MAX_PUBLIC_KEYS ||
      v.publicKeys.some(key => !rsaPublicKey(key))
    ) {
      return null;
    }
    publicKeys = [...(v.publicKeys as string[])];
  } else {
    if (!["hex", "base64", "utf8"].includes(v.secretEncoding as string)) {
      return null;
    }
    if (v.publicKeys !== undefined) return null;
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
  const hasParam = v.signatureParam !== undefined;
  if (
    hasParam &&
    (typeof v.signatureParam !== "string" || !PARAM_NAME.test(v.signatureParam))
  ) {
    return null;
  }
  const hasTimestampHeader = v.timestampHeader !== undefined;
  const hasTimestampParam = v.timestampParam !== undefined;
  const hasTolerance = v.toleranceSeconds !== undefined;
  if (hasTimestampHeader && hasTimestampParam) return null;
  if ((hasTimestampHeader || hasTimestampParam) !== hasTolerance) return null;
  if (
    hasTimestampHeader &&
    (typeof v.timestampHeader !== "string" ||
      !HEADER_NAME.test(v.timestampHeader))
  ) {
    return null;
  }
  if (
    hasTimestampParam &&
    (!hasParam ||
      typeof v.timestampParam !== "string" ||
      !PARAM_NAME.test(v.timestampParam))
  ) {
    return null;
  }
  if (
    hasTolerance &&
    (!Number.isSafeInteger(v.toleranceSeconds) ||
      (v.toleranceSeconds as number) < 1 ||
      (v.toleranceSeconds as number) > MAX_TOLERANCE_SECONDS)
  ) {
    return null;
  }
  let testNotification: DeclaredWebhookVerification["testNotification"];
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
  const parts = v.signedPayload;
  if (!Array.isArray(parts) || parts.length === 0 || parts.length > 8) {
    return null;
  }
  if (!parts.includes("body")) return null;
  // A window on a timestamp the signature does not cover is no window: a
  // replay would carry an old body with a fresh header. The timestamp must
  // be signed.
  if (hasTimestampHeader && !parts.includes(`header:${v.timestampHeader}`)) {
    return null;
  }
  if (hasTimestampParam && !parts.includes(`param:${v.timestampParam}`)) {
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
      hasParam &&
      typeof part === "string" &&
      part.startsWith("param:") &&
      PARAM_NAME.test(part.slice("param:".length))
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
    scheme: rsa ? "rsa-sha256" : "hmac-sha256",
    ...(rsa
      ? { publicKeys }
      : {
          secretEncoding:
            v.secretEncoding as DeclaredWebhookVerification["secretEncoding"],
        }),
    signedPayload: [...(parts as string[])],
    signatureHeader: v.signatureHeader,
    signatureEncoding:
      v.signatureEncoding as DeclaredWebhookVerification["signatureEncoding"],
    ...(typeof v.signaturePrefix === "string"
      ? { signaturePrefix: v.signaturePrefix }
      : {}),
    ...(hasParam ? { signatureParam: v.signatureParam as string } : {}),
    ...(hasTimestampHeader
      ? { timestampHeader: v.timestampHeader as string }
      : {}),
    ...(hasTimestampParam
      ? { timestampParam: v.timestampParam as string }
      : {}),
    ...(hasTolerance ? { toleranceSeconds: v.toleranceSeconds as number } : {}),
    ...(testNotification ? { testNotification } : {}),
  };
}

/** The delivery declaration in an indexed spec, or null when none is valid. */
export function declaredWebhookDelivery(
  spec: unknown,
): DeclaredWebhookDelivery | null {
  const d = (spec as { mako?: { webhooks?: { delivery?: unknown } } })?.mako
    ?.webhooks?.delivery as Record<string, unknown> | undefined;
  if (!d || typeof d !== "object") return null;
  for (const key of Object.keys(d)) {
    if (!["idHeader", "idFields", "typeField"].includes(key)) return null;
  }
  if (
    d.idHeader !== undefined &&
    (typeof d.idHeader !== "string" || !HEADER_NAME.test(d.idHeader))
  ) {
    return null;
  }
  if (
    d.idFields !== undefined &&
    (!Array.isArray(d.idFields) ||
      d.idFields.length === 0 ||
      d.idFields.length > 4 ||
      d.idFields.some(f => typeof f !== "string" || !FIELD_PATH.test(f)))
  ) {
    return null;
  }
  if (
    d.typeField !== undefined &&
    (typeof d.typeField !== "string" || !FIELD_PATH.test(d.typeField))
  ) {
    return null;
  }
  return {
    ...(d.idHeader ? { idHeader: d.idHeader as string } : {}),
    ...(d.idFields ? { idFields: [...(d.idFields as string[])] } : {}),
    ...(d.typeField ? { typeField: d.typeField as string } : {}),
  };
}

/** A dotted path's value, own properties only. */
function pick(value: unknown, path: string): unknown {
  let current = value;
  for (const key of path.split(".")) {
    if (
      !current ||
      typeof current !== "object" ||
      Array.isArray(current) ||
      !Object.prototype.hasOwnProperty.call(current, key)
    ) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

const scalar = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0
    ? value
    : typeof value === "number" && Number.isFinite(value)
      ? String(value)
      : undefined;

/**
 * A verified event with the id and type its delivery declaration names,
 * as `id` and `type`, the keys the webhook route stores it by. An event
 * the declaration finds nothing for is returned unchanged.
 */
export function identifyDeclaredEvent(
  delivery: DeclaredWebhookDelivery | null,
  event: unknown,
  headers: Record<string, string | string[] | undefined>,
): unknown {
  if (
    !delivery ||
    !event ||
    typeof event !== "object" ||
    Array.isArray(event)
  ) {
    return event;
  }
  let id = delivery.idHeader
    ? scalar(header(headers, delivery.idHeader))
    : undefined;
  if (!id && delivery.idFields) {
    const values = delivery.idFields.map(field => scalar(pick(event, field)));
    if (values.every(v => v !== undefined)) id = values.join(":");
  }
  const type = delivery.typeField
    ? scalar(pick(event, delivery.typeField))
    : undefined;
  if (id === undefined && type === undefined) return event;
  return {
    ...(event as Record<string, unknown>),
    ...(type !== undefined ? { type } : {}),
    ...(id !== undefined ? { id: id.slice(0, 512) } : {}),
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
 * `k=v,k=v` → its pairs, keys and values trimmed. A key given twice counts
 * once, the last, as Calendly's own parser reads it. Null when malformed.
 */
function headerParams(value: string): Map<string, string> | null {
  const params = new Map<string, string>();
  for (const part of value.split(",")) {
    const at = part.indexOf("=");
    if (at <= 0) continue;
    const key = part.slice(0, at).trim();
    const val = part.slice(at + 1).trim();
    if (key && val) params.set(key, val);
  }
  return params.size > 0 ? params : null;
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
 * Check one delivery against a declaration (with the flow's secret for
 * HMAC). Valid means the signature matched (in constant time for HMAC) and
 * the body is JSON, or the delivery is the declared test notification.
 * The event carries the id and type `delivery` names.
 */
export function verifyDeclaredWebhook(
  declaration: DeclaredWebhookVerification,
  options: {
    payload: string;
    headers: Record<string, string | string[] | undefined>;
    secret?: string;
    /** The time now, for the replay window. */
    now?: Date;
    /** Where the event id and type are (the declared `delivery`). */
    delivery?: DeclaredWebhookDelivery | null;
  },
): WebhookVerificationResult {
  const { payload, headers, secret } = options;

  // The vendor's test ping: answered whatever its signature, stored with
  // no payload under a type no entity maps, so nothing it says is written.
  const test = declaration.testNotification;
  if (
    test &&
    header(headers, test.header)?.trim().toLowerCase() ===
      test.value.toLowerCase()
  ) {
    const deliveryId = options.delivery?.idHeader
      ? header(headers, options.delivery.idHeader)
      : undefined;
    return {
      valid: true,
      event: {
        type: test.eventType,
        id: `test:${deliveryId ? deliveryId.slice(0, 256) : randomUUID()}`,
      },
    };
  }

  let key: Buffer | null = null;
  if (declaration.scheme === "hmac-sha256") {
    if (!secret) return { valid: false, error: "Missing webhook secret" };
    key = keyOf(
      secret,
      declaration.secretEncoding as NonNullable<
        DeclaredWebhookVerification["secretEncoding"]
      >,
    );
    if (!key) return { valid: false, error: "The webhook secret is malformed" };
  }

  const signatureValue = header(headers, declaration.signatureHeader);
  if (!signatureValue) {
    return {
      valid: false,
      error: `Missing ${declaration.signatureHeader} header`,
    };
  }
  let params: Map<string, string> | null = null;
  let presented = signatureValue;
  if (declaration.signatureParam) {
    params = headerParams(signatureValue);
    const value = params?.get(declaration.signatureParam);
    if (!value) {
      return {
        valid: false,
        error: `Malformed ${declaration.signatureHeader} header`,
      };
    }
    presented = value;
  }

  if (declaration.timestampHeader || declaration.timestampParam) {
    const sent = declaration.timestampHeader
      ? header(headers, declaration.timestampHeader)
      : params?.get(declaration.timestampParam as string);
    const name = declaration.timestampHeader ?? declaration.timestampParam;
    if (!sent || !/^\d{1,12}$/.test(sent)) {
      return {
        valid: false,
        error: `Missing or malformed ${name} timestamp`,
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

  const chunks: Buffer[] = [];
  for (const part of declaration.signedPayload) {
    if (part === "body") {
      chunks.push(Buffer.from(payload, "utf8"));
    } else if (part.startsWith("header:")) {
      const name = part.slice("header:".length);
      const value = header(headers, name);
      if (value === undefined) {
        return { valid: false, error: `Missing ${name} header` };
      }
      chunks.push(Buffer.from(value, "utf8"));
    } else if (part.startsWith("param:")) {
      const name = part.slice("param:".length);
      const value = params?.get(name);
      if (value === undefined) {
        return { valid: false, error: `Missing ${name} in the signature` };
      }
      chunks.push(Buffer.from(value, "utf8"));
    } else {
      chunks.push(Buffer.from(part.slice("literal:".length), "utf8"));
    }
  }
  const signed = Buffer.concat(chunks);
  const given = presented.slice(prefix.length);

  let matched = false;
  if (declaration.scheme === "hmac-sha256") {
    const expected = Buffer.from(
      createHmac("sha256", key as Buffer)
        .update(signed)
        .digest(declaration.signatureEncoding),
      "utf8",
    );
    const givenBytes = Buffer.from(given, "utf8");
    matched =
      expected.length === givenBytes.length &&
      timingSafeEqual(expected, givenBytes);
  } else {
    const signature = Buffer.from(given, declaration.signatureEncoding);
    if (signature.length > 0) {
      for (const pem of declaration.publicKeys ?? []) {
        const publicKey = rsaPublicKey(pem);
        if (!publicKey) continue;
        try {
          if (verifySignature("sha256", signed, publicKey, signature)) {
            matched = true;
            break;
          }
        } catch {
          // A signature this key cannot read: try the next key.
        }
      }
    }
  }
  if (!matched) return { valid: false, error: "Invalid signature" };
  let event: unknown;
  try {
    event = JSON.parse(payload);
  } catch {
    return { valid: false, error: "Invalid JSON payload" };
  }
  return {
    valid: true,
    event: identifyDeclaredEvent(options.delivery ?? null, event, headers),
  };
}
