/**
 * A real person's user id: canonical RFC 9562 UUID (UUIDv7 for Postgres users,
 * legacy UUIDv4), 15 characters of [0-9a-z] (legacy Lucia / truncated UUID),
 * or a legacy 24-hex id. Every system actor fails: PUBLISH_ACTOR, "api-key",
 * "", connector session prefixes.
 *
 * A leaf module with no imports, so the sandbox provider can use it without
 * the worktrees -> sandbox/provider -> e2b-provider import cycle.
 */
const CANONICAL_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isPersonActorId(actorId: string): boolean {
  return (
    CANONICAL_UUID_RE.test(actorId) ||
    /^[0-9a-z]{15}$/.test(actorId) ||
    /^[0-9a-f]{24}$/i.test(actorId)
  );
}
