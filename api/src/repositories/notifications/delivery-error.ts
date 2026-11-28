// PostgreSQL text excludes NUL and isolated UTF-16 surrogates. JSON escaping
// preserves those code units and keeps ordinary error messages readable in SQL.
import { sanitizePgString } from "../../utils/message-sanitizer";

const prefix = "\u001emako:delivery-error:";

export function encodeDeliveryError(value: string): string {
  return value.startsWith(prefix) || sanitizePgString(value) !== value
    ? prefix + JSON.stringify(value)
    : value;
}

export function decodeDeliveryError(value: string): string {
  if (!value.startsWith(prefix)) return value;
  try {
    const decoded: unknown = JSON.parse(value.slice(prefix.length));
    if (typeof decoded === "string" && encodeDeliveryError(decoded) === value) {
      return decoded;
    }
  } catch {
    // A pre-existing plain-text error may start with the reserved prefix.
  }
  return value;
}
