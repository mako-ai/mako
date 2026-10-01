/**
 * Keep a connection's secrets out of a dbt run's log.
 *
 * The runner hands dbt its credentials as env vars (`DBT_SECRET_*`) and
 * keyfiles. Anything dbt prints goes to the run log — and dbt code can print
 * whatever it can read (`{{ log(env_var('DBT_SECRET_PASSWORD'), info=True) }}`).
 * With `mako dbt run` that code comes from a laptop and the log streams back
 * to it, so every line is scrubbed of the values the runner itself injected
 * before it is stored. Best effort by nature (a macro can encode a value
 * first), but it closes the direct echo.
 */
import type { RenderedProfile } from "./adapter-map";

export const REDACTED = "[redacted]";

/** Shorter values would redact ordinary words; no real secret is this short. */
const MIN_SECRET_LENGTH = 6;

/** Keyfile JSON fields that are secret (a service account's email is not). */
const SECRET_JSON_KEYS = new Set([
  "private_key",
  "private_key_id",
  "client_secret",
  "refresh_token",
  "password",
  "token",
]);

function withEscapedForms(value: string): string[] {
  const escaped = JSON.stringify(value).slice(1, -1);
  return escaped === value ? [value] : [value, escaped];
}

/** Every value the runner injects that must never appear in a log. */
export function collectProfileSecrets(
  profile: Pick<RenderedProfile, "secretEnv" | "keyfiles">,
): string[] {
  const out = new Set<string>();
  const add = (value: unknown) => {
    if (typeof value !== "string" || value.length < MIN_SECRET_LENGTH) return;
    for (const form of withEscapedForms(value)) out.add(form);
    // A PEM key is printed line by line as often as whole.
    for (const line of value.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed.length >= 16 && !trimmed.startsWith("-----")) {
        out.add(trimmed);
      }
    }
  };
  for (const value of Object.values(profile.secretEnv ?? {})) add(value);
  for (const keyfile of profile.keyfiles ?? []) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(keyfile.content);
    } catch {
      add(keyfile.content);
      continue;
    }
    if (parsed && typeof parsed === "object") {
      for (const [key, value] of Object.entries(parsed)) {
        if (SECRET_JSON_KEYS.has(key)) add(value);
      }
    }
  }
  return [...out];
}

/** A line scrubber for these secrets (longest first, so no partial leaks). */
export function createSecretRedactor(
  secrets: readonly string[],
): (line: string) => string {
  const ordered = [...new Set(secrets)]
    .filter(secret => secret.length >= MIN_SECRET_LENGTH)
    .sort((a, b) => b.length - a.length);
  if (ordered.length === 0) return line => line;
  return line => {
    let out = line;
    for (const secret of ordered) {
      if (out.includes(secret)) out = out.split(secret).join(REDACTED);
    }
    return out;
  };
}
