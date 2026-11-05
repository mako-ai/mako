/**
 * Finding and removing secret values in text. Shared by the connection probe
 * (connectors/probe.service.ts) and the connection proxy
 * (connections/forward.ts), so both scrub the same way.
 */

/**
 * Every string the config holds that is long enough to be a credential.
 *
 * All of them, not only the fields the schema marks secret: a schema that
 * forgot `airbyte_secret` is exactly the case in which a value must still not
 * reach an agent's context. Short values (a region, a port, "self") are left
 * alone — scrubbing "eu" out of every record would be noise, not safety.
 */
export function secretValuesOf(config: unknown): string[] {
  const found = new Set<string>();
  const walk = (value: unknown): void => {
    if (typeof value === "string") {
      if (value.length >= 6) found.add(value);
    } else if (Array.isArray(value)) {
      value.forEach(walk);
    } else if (value && typeof value === "object") {
      Object.values(value as Record<string, unknown>).forEach(walk);
    }
  };
  walk(config);
  // Longest first, so a value that contains another is scrubbed whole.
  return [...found].sort((a, b) => b.length - a.length);
}

/**
 * Replace every occurrence of each secret in `text`: as is, JSON-escaped
 * (with `\/` slashes too), and percent-encoded in either hex case.
 */
export function redactSecrets(
  text: string,
  secrets: readonly string[],
): string {
  let out = text;
  for (const secret of secrets) {
    if (!secret) continue;
    out = out.split(secret).join("[redacted]");
    // JSON-escaped form too: a secret with a quote or a backslash in it
    // appears differently inside a serialized record than in prose.
    const escaped = JSON.stringify(secret).slice(1, -1);
    for (const form of [escaped, escaped.replace(/\//g, "\\/")]) {
      if (form !== secret) out = out.split(form).join("[redacted]");
    }
    const encoded = percentEncodedPattern(secret);
    if (encoded) out = out.replace(encoded, "[redacted]");
  }
  return out;
}

/** `value` URL-encoded, matching `%2f` as well as `%2F`; null if unchanged. */
function percentEncodedPattern(value: string): RegExp | null {
  const encoded = encodeURIComponent(value);
  if (encoded === value) return null;
  const hex = (c: string) => (/[A-F]/.test(c) ? `[${c}${c.toLowerCase()}]` : c);
  const source = encoded
    .split(/(%[0-9A-F]{2})/)
    .map((part, i) =>
      i % 2
        ? `%${hex(part[1])}${hex(part[2])}`
        : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    )
    .join("");
  return new RegExp(source, "g");
}
