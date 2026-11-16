/**
 * The small part of semver the registry needs, and the `source:` reference.
 *
 * A registry version is `MAJOR.MINOR.PATCH`, nothing else: no pre-release, no
 * build metadata. A range is one of the forms people write in a dependency
 * line, each meaning what npm means by it:
 *
 *   1        >=1.0.0 <2.0.0          1.x     same
 *   1.4      >=1.4.0 <1.5.0          1.4.x   same
 *   ^1.4.2   >=1.4.2 <2.0.0          (^0.4.2 is >=0.4.2 <0.5.0)
 *   ~1.4.2   >=1.4.2 <1.5.0
 *   1.4.2    exactly 1.4.2
 *
 * Kept in-house rather than adding the `semver` package: these seven forms
 * are the whole contract, and a refusal for anything else is clearer than a
 * range that silently means something the author did not intend.
 */

export interface Version {
  major: number;
  minor: number;
  patch: number;
}

const VERSION = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/;
const NUMBER = "(0|[1-9]\\d{0,8})";

export function parseVersion(text: string): Version | null {
  const match = VERSION.exec(text.trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

export function formatVersion(version: Version): string {
  return `${version.major}.${version.minor}.${version.patch}`;
}

export function compareVersions(a: Version, b: Version): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

/** A half-open interval `[min, max)`; `max` absent means unbounded. */
export interface Range {
  text: string;
  min: Version;
  max?: Version;
}

const v = (major: number, minor: number, patch: number): Version => ({
  major,
  minor,
  patch,
});

export function parseRange(text: string): Range | null {
  const raw = text.trim();
  let match: RegExpExecArray | null;

  if ((match = new RegExp(`^${NUMBER}(?:\\.x)?$`).exec(raw))) {
    const major = Number(match[1]);
    return { text: raw, min: v(major, 0, 0), max: v(major + 1, 0, 0) };
  }
  if ((match = new RegExp(`^${NUMBER}\\.${NUMBER}(?:\\.x)?$`).exec(raw))) {
    const major = Number(match[1]);
    const minor = Number(match[2]);
    return {
      text: raw,
      min: v(major, minor, 0),
      max: v(major, minor + 1, 0),
    };
  }
  if (
    (match = new RegExp(`^\\^${NUMBER}\\.${NUMBER}\\.${NUMBER}$`).exec(raw))
  ) {
    const min = v(Number(match[1]), Number(match[2]), Number(match[3]));
    const max =
      min.major > 0
        ? v(min.major + 1, 0, 0)
        : min.minor > 0
          ? v(0, min.minor + 1, 0)
          : v(0, 0, min.patch + 1);
    return { text: raw, min, max };
  }
  if ((match = new RegExp(`^~${NUMBER}\\.${NUMBER}\\.${NUMBER}$`).exec(raw))) {
    const min = v(Number(match[1]), Number(match[2]), Number(match[3]));
    return { text: raw, min, max: v(min.major, min.minor + 1, 0) };
  }
  const exact = parseVersion(raw);
  if (exact) {
    return {
      text: raw,
      min: exact,
      max: v(exact.major, exact.minor, exact.patch + 1),
    };
  }
  return null;
}

export function satisfies(version: Version, range: Range): boolean {
  if (compareVersions(version, range.min) < 0) return false;
  return !range.max || compareVersions(version, range.max) < 0;
}

/** The newest of `versions` inside `range`, or null. */
export function maxSatisfying(
  versions: Iterable<string>,
  range: Range,
): string | null {
  let best: Version | null = null;
  for (const text of versions) {
    const version = parseVersion(text);
    if (!version || !satisfies(version, range)) continue;
    if (!best || compareVersions(version, best) > 0) best = version;
  }
  return best ? formatVersion(best) : null;
}

/** The newest of `versions`, or null. */
export function maxVersion(versions: Iterable<string>): string | null {
  let best: Version | null = null;
  for (const text of versions) {
    const version = parseVersion(text);
    if (version && (!best || compareVersions(version, best) > 0)) {
      best = version;
    }
  }
  return best ? formatVersion(best) : null;
}

/** Newest first. Unparseable entries are dropped. */
export function sortVersionsDescending(versions: Iterable<string>): string[] {
  return [...versions]
    .map(text => ({ text, version: parseVersion(text) }))
    .filter((entry): entry is { text: string; version: Version } =>
      Boolean(entry.version),
    )
    .sort((a, b) => compareVersions(b.version, a.version))
    .map(entry => entry.text);
}

/** `mako/stripe@1` once parsed. */
export interface RegistryReference {
  /** The reference as written, trimmed. */
  text: string;
  /** Who publishes it. Only `mako` exists today. */
  publisher: "mako";
  /** The registry slug: `connectors/<slug>/` in the Mako repo. */
  slug: string;
  range: Range;
}

const SLUG = /^[a-z][a-z0-9-]{0,63}$/;

/**
 * Parse a `source:` value. Every refusal names the form that works, because
 * the reader is whoever just pushed the line.
 */
export function parseRegistryReference(
  text: string,
): { ok: true; value: RegistryReference } | { ok: false; reason: string } {
  const raw = text.trim();
  const example = "e.g. `source: mako/stripe@1`";
  const at = raw.lastIndexOf("@");
  if (at <= 0) {
    return {
      ok: false,
      reason: `\`source\` must be <publisher>/<slug>@<version range>, ${example}.`,
    };
  }
  const name = raw.slice(0, at);
  const rangeText = raw.slice(at + 1);
  const [publisher, slug, ...rest] = name.split("/");
  if (publisher !== "mako" || !slug || rest.length > 0) {
    return {
      ok: false,
      reason: `\`source\` must name a Mako connector as mako/<slug>@<range>, ${example}. Only the mako publisher exists today.`,
    };
  }
  if (!SLUG.test(slug)) {
    return {
      ok: false,
      reason: `"${slug}" is not a connector slug; it must be lowercase letters, digits and dashes, ${example}.`,
    };
  }
  const range = parseRange(rangeText);
  if (!range) {
    return {
      ok: false,
      reason:
        `"${rangeText}" is not a version range Mako understands. Use a major (1), a minor (1.4), ` +
        `a caret (^1.4.2), a tilde (~1.4.2) or an exact version (1.4.2).`,
    };
  }
  return { ok: true, value: { text: raw, publisher: "mako", slug, range } };
}
