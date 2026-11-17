/**
 * A real person's user id: 15 characters of [0-9a-z] (auth.service.ts
 * generateId: hex from a UUID today, base36 from Lucia for older accounts),
 * or a legacy 24-hex id. Every system actor fails: PUBLISH_ACTOR, "api-key",
 * "", connector session prefixes.
 *
 * A leaf module with no imports, so the sandbox provider can use it without
 * the worktrees -> sandbox/provider -> e2b-provider import cycle.
 */
export function isPersonActorId(actorId: string): boolean {
  return /^[0-9a-z]{15}$/.test(actorId) || /^[0-9a-f]{24}$/i.test(actorId);
}
