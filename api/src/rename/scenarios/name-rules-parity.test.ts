/**
 * One set of name rules, two entry points: the API's rename services
 * (rename/title-rules.ts) and the app's rename dialog
 * (app/src/lib/object-name-rules.ts). Both import `@mako/schemas`
 * (object-names.ts); this holds them to the same answer and the same words
 * on a hostile corpus, pins what the rules decide, and ties the file-name
 * rule to what creation mints (utils/slugify.ts).
 *
 * The app module is loaded by path at run time, not imported: an import
 * would pull a file from outside `api/src` into the API's TypeScript
 * program (TS6059).
 */
import path from "node:path";
import { pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

import { slugifyName } from "../../utils/slugify";
import {
  cleanRenameSlug,
  cleanRenameTitle,
  displayNameError,
  isRenameSlug,
  normalizeDisplayName,
  renameSlugError,
} from "../title-rules";
import { RenameError } from "../types";

interface AppNameRules {
  normalizeObjectName(raw: string): string;
  objectNameError(raw: string, maxLength: number): string | null;
  objectSlugError(kind: "flow" | "dbt_job", raw: string): string | null;
}

let app: AppNameRules;
beforeAll(async () => {
  const entry = pathToFileURL(
    path.resolve(__dirname, "../../../../app/src/lib/object-name-rules.ts"),
  ).href;
  app = (await import(/* @vite-ignore */ entry)) as AppNameRules;
});

const KINDS = ["flow", "dbt_job"] as const;
const MAX = 200;

/** [label, as typed, "refused" or the name as stored]. */
const TITLES: ReadonlyArray<[string, string, string]> = [
  ["empty", "", "refused"],
  ["whitespace only", "   \t ", "refused"],
  ["zero-width only", "\u{200B}\u{200C}\u{FEFF}", "refused"],
  ["NUL", "a\u0000b", "refused"],
  ["bell", "a\u0007b", "refused"],
  ["newline", "line one\nline two", "refused"],
  ["carriage return", "a\rb", "refused"],
  ["tab", "a\tb", "refused"],
  ["DEL", "a\u007Fb", "refused"],
  ["C1 control", "a\u0085b", "refused"],
  ["line separator", "a\u{2028}b", "refused"],
  ["RTL override", "\u{202E}gnp.exe", "refused"],
  ["bidi isolate", "a\u{2066}b\u{2069}", "refused"],
  ["one past the cap", "x".repeat(MAX + 1), "refused"],
  ["10000 chars", "x".repeat(10000), "refused"],
  ["emoji past the cap", "\u{1F600}".repeat(MAX / 2 + 1), "refused"],
  ["at the cap", "x".repeat(MAX), "x".repeat(MAX)],
  [
    "emoji at the cap",
    "\u{1F600}".repeat(MAX / 2),
    "\u{1F600}".repeat(MAX / 2),
  ],
  ["padded", "  Padded name  ", "Padded name"],
  ["NFD e-acute", "Cafe\u{301} sync", "Caf\u{E9} sync"],
  [
    "emoji with joiners",
    "\u{1F4C8} Revenue \u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}",
    "\u{1F4C8} Revenue \u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}",
  ],
  [
    "RTL script",
    "\u{5EA}\u{5D6}\u{5E8}\u{5D9}\u{5DD}",
    "\u{5EA}\u{5D6}\u{5E8}\u{5D9}\u{5DD}",
  ],
  ["path tricks", "../../etc/passwd", "../../etc/passwd"],
  ["Windows-invalid chars", 'a: * ? " < > | b', 'a: * ? " < > | b'],
  ["YAML-special", "- [x]: {y} # z & *a !b", "- [x]: {y} # z & *a !b"],
  ["looks like an id", "0123456789abcdef01234567", "0123456789abcdef01234567"],
  ["YAML true", "true", "true"],
  ["YAML date", "2026-10-07", "2026-10-07"],
];

/** [label, as typed, whether it may be a file name]. */
const SLUGS: ReadonlyArray<[string, string, boolean]> = [
  ["empty", "", false],
  ["whitespace only", "   ", false],
  ["dot-dot", "..", false],
  ["slash", "/", false],
  ["nested path", "a/b", false],
  ["backslash path", "a\\b", false],
  ["parent escape", "../escape", false],
  ["encoded slash", "a%2Fb", false],
  ["upper case", "Upper-Case", false],
  ["e-acute (NFC)", "caf\u{E9}", false],
  ["e + combining acute (NFD)", "cafe\u{301}", false],
  ["emoji", "rocket-\u{1F680}", false],
  ["zero-width", "a\u{200B}b", false],
  ["RTL override", "\u{202E}abc", false],
  ["NUL", "a\u0000b", false],
  ["newline", "a\nb", false],
  ["colon", "a:b", false],
  ["trailing dot", "abc.", false],
  ["double dash", "a--b", false],
  ["leading dash", "-a", false],
  ["trailing dash", "a-", false],
  ["underscore", "a_b", false],
  ["Windows reserved CON", "con", false],
  ["Windows reserved NUL", "nul", false],
  ["Windows reserved COM1", "com1", false],
  ["Windows reserved LPT9", "lpt9", false],
  ["24-hex id lookalike", "0123456789abcdef01234567", false],
  ["65 chars", "a".repeat(65), false],
  ["64 chars", "a".repeat(64), true],
  ["padded", "  plain-slug ", true],
  ["a folder's name", "flows", true],
  ["not a device name", "con-1", true],
  ["not a device name either", "com10", true],
  ["23 hex: not an id", "0123456789abcdef0123456", true],
  ["digits", "2026", true],
];

describe("display names", () => {
  it("are refused or stored exactly as the table says", () => {
    for (const [label, typed, want] of TITLES) {
      const error = displayNameError(normalizeDisplayName(typed), MAX);
      if (want === "refused") {
        expect(error, label).not.toBeNull();
        expect(() => cleanRenameTitle(typed, MAX), label).toThrow(RenameError);
      } else {
        expect(error, label).toBeNull();
        expect(cleanRenameTitle(typed, MAX), label).toBe(want);
      }
    }
  });

  it("get the same answer, in the same words, from the app's entry point", () => {
    for (const [label, typed] of TITLES) {
      expect(app.normalizeObjectName(typed), label).toBe(
        normalizeDisplayName(typed),
      );
      expect(app.objectNameError(typed, MAX), label).toBe(
        displayNameError(normalizeDisplayName(typed), MAX),
      );
    }
  });

  it("a refusal is a 400 carrying the reason", () => {
    expect(() => cleanRenameTitle("a\nb", MAX)).toThrow(
      expect.objectContaining({
        status: 400,
        message: app.objectNameError("a\nb", MAX),
      }),
    );
  });
});

describe("file names", () => {
  it("are accepted or refused exactly as the table says", () => {
    for (const kind of KINDS) {
      for (const [label, typed, ok] of SLUGS) {
        const error = renameSlugError(kind, typed.trim());
        expect(error === null, `${kind} ${label}`).toBe(ok);
        if (ok) {
          expect(cleanRenameSlug(kind, typed), label).toBe(typed.trim());
        } else {
          expect(() => cleanRenameSlug(kind, typed), label).toThrow(
            RenameError,
          );
        }
      }
    }
  });

  it("get the same answer, in the same words, from the app's entry point", () => {
    for (const kind of KINDS) {
      for (const [label, typed] of SLUGS) {
        expect(app.objectSlugError(kind, typed), `${kind} ${label}`).toBe(
          renameSlugError(kind, typed.trim()),
        );
      }
    }
  });

  it("say where the file would live", () => {
    expect(renameSlugError("flow", "Bad Name")).toContain("flows/Bad Name.yml");
    expect(renameSlugError("dbt_job", "Bad Name")).toContain(
      "dbt/jobs/Bad Name.yml",
    );
  });

  it("the character rule is what creation mints: a slug slugifyName leaves alone", () => {
    for (const [label, typed] of SLUGS) {
      const slug = typed.trim();
      expect(isRenameSlug(slug), label).toBe(
        slug !== "" && slugifyName(slug, { fallback: "" }) === slug,
      );
    }
    for (const name of ["Nightly Build", "Caf\u{E9} sync", "x".repeat(300)]) {
      expect(isRenameSlug(slugifyName(name)), name.slice(0, 20)).toBe(true);
    }
  });
});
