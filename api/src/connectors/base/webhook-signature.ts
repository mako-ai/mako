/**
 * Webhook verification primitives shared by the connectors: the raw body a
 * signature is computed over, HMAC digests, and constant-time comparison.
 *
 * Every comparison of a provided signature or secret against the expected
 * one goes through `timingSafeEqualHex` / `timingSafeEqualString`: a plain
 * `===` returns early at the first differing byte, which leaks how much of
 * a guess was right.
 */
import crypto from "node:crypto";

/** The body as signed: a string payload as is, anything else as JSON. */
export function rawWebhookBody(payload: unknown): string {
  return typeof payload === "string" ? payload : JSON.stringify(payload);
}

/** Hex HMAC of `data` (UTF-8) under `key`. */
export function hmacHex(
  key: string | Buffer,
  data: string,
  algorithm = "sha256",
): string {
  return crypto.createHmac(algorithm, key).update(data, "utf8").digest("hex");
}

/**
 * Constant-time equality of two hex digests, compared as bytes (so case
 * does not matter). Unequal lengths or non-hex input are simply unequal —
 * never a thrown "Input buffers must have the same byte length".
 */
export function timingSafeEqualHex(
  expected: string,
  provided: string,
): boolean {
  const expectedBuf = Buffer.from(expected, "hex");
  const providedBuf = Buffer.from(provided, "hex");
  return (
    expectedBuf.length > 0 &&
    expectedBuf.length === providedBuf.length &&
    crypto.timingSafeEqual(expectedBuf, providedBuf)
  );
}

/**
 * Constant-time equality of two strings (UTF-8 bytes, case-sensitive), for
 * shared secrets echoed in a header. Unequal lengths are unequal.
 */
export function timingSafeEqualString(
  expected: string,
  provided: string,
): boolean {
  const expectedBuf = Buffer.from(expected, "utf8");
  const providedBuf = Buffer.from(provided, "utf8");
  return (
    expectedBuf.length === providedBuf.length &&
    crypto.timingSafeEqual(expectedBuf, providedBuf)
  );
}
