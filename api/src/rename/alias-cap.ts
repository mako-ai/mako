/**
 * How many old names an object keeps. A name older than the newest 24 is
 * dropped: it resolves to nothing from then on (never to another object),
 * and a new object may take it. Aliases are kept oldest first, so the cap
 * keeps the tail.
 */
export const MAX_ALIASES = 24;

/** The newest `MAX_ALIASES` of an oldest-first alias list. */
export function capAliases<T>(aliases: T[]): T[] {
  return aliases.length > MAX_ALIASES ? aliases.slice(-MAX_ALIASES) : aliases;
}
