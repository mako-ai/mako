/**
 * Generate a MongoDB ObjectId on the client side.
 * Uses the same format as MongoDB ObjectId (24-char hex string).
 */
export function generateObjectId(): string {
  // 4-byte timestamp (seconds since Unix epoch)
  const timestamp = Math.floor(Date.now() / 1000)
    .toString(16)
    .padStart(8, "0");

  // 5-byte random value (10 hex chars)
  const randomBytes = crypto.getRandomValues(new Uint8Array(5));
  const randomValue = Array.from(randomBytes, b =>
    b.toString(16).padStart(2, "0"),
  ).join("");

  // 3-byte counter (6 hex chars) - random for simplicity
  const counterBytes = crypto.getRandomValues(new Uint8Array(3));
  const counter = Array.from(counterBytes, b =>
    b.toString(16).padStart(2, "0"),
  ).join("");

  return timestamp + randomValue + counter;
}

/**
 * A console id the server can address: a 24-char hex ObjectId (a row's id,
 * or the id derived from a git-only console's file). Editor-internal ids —
 * `binding:<appId>:<file>` for an app binding open in the console editor —
 * are not, and must never reach the console save route.
 */
export function isObjectIdString(id: string | undefined | null): boolean {
  return typeof id === "string" && /^[0-9a-f]{24}$/i.test(id);
}
