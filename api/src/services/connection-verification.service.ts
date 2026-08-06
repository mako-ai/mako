import { Types } from "mongoose";
import { ConnectionVerification } from "../database/workspace-schema";
import { loggers } from "../logging";

const logger = loggers.db();

// Ordered: first match wins. Buckets chosen so a failure-mode rollup answers
// "why do connection tests fail" without reading raw driver messages.
const ERROR_CLASSES: Array<[RegExp, string]> = [
  [
    /auth|password|credential|access denied|login failed|permission denied|28p01|1045/i,
    "auth_failed",
  ],
  [/enotfound|getaddrinfo|name or service not known|dns/i, "host_not_found"],
  [/econnrefused|connection refused/i, "connection_refused"],
  [/etimedout|timed?\s?out/i, "timeout"],
  [/ssl|tls|certificate/i, "tls"],
  [
    /firewall|allowlist|whitelist|not allowed to connect|pg_hba|ip address/i,
    "network_blocked",
  ],
  [/does not exist|unknown database|not found/i, "database_not_found"],
  [/unsupported database type/i, "unsupported_type"],
];

export function classifyConnectionError(error: string): string {
  for (const [pattern, cls] of ERROR_CLASSES) {
    if (pattern.test(error)) return cls;
  }
  return "other";
}

/**
 * Fire-and-forget record of a connection test outcome. Never throws and never
 * blocks the response path — losing a telemetry row is always preferable to
 * failing or slowing the actual connection test.
 */
export function recordConnectionVerification(entry: {
  userId?: string;
  workspaceId?: Types.ObjectId;
  connectionId?: Types.ObjectId;
  databaseType: string;
  trigger: "standalone_test" | "create_verify" | "update_verify" | "saved_test";
  success: boolean;
  durationMs: number;
  error?: string;
}): void {
  const { error, ...rest } = entry;
  void ConnectionVerification.create({
    ...rest,
    verifiedAt: new Date(),
    ...(error && !entry.success
      ? {
          errorClass: classifyConnectionError(error),
          errorMessage: error.slice(0, 500),
        }
      : {}),
  }).catch((err: unknown) => {
    logger.warn("Failed to record connection verification", { err });
  });
}
