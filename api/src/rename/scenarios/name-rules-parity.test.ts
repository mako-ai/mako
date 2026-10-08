/**
 * The rename dialog refuses, as it is typed, exactly what the server
 * refuses — with the server's words. The dialog holds a dependency-free copy
 * of the rules (app/src/lib/object-name-rules.ts); this pins the copy to the
 * server (rename/title-rules.ts) on the hostile corpus of the scenario
 * suites plus the length boundaries. Change one, and this fails until the
 * other follows.
 */
import { describe, expect, it } from "vitest";

import {
  OBJECT_NAME_MAX_LENGTH,
  appFolderNameError,
  appLinkError,
  appNameError,
  normalizeAppName,
  normalizeObjectName,
  objectNameError,
  objectSlugError,
  type NamedObjectKind,
} from "../../../../app/src/lib/object-name-rules";
import { FLOW_NAME_MAX_LENGTH } from "../flow-rename";
import {
  RESERVED_APP_SLUGS,
  appTitleProblem,
  newAppSlugProblem,
  newSegmentProblem,
  normalizeName,
} from "../../apps/app-paths";
import { JOB_NAME_MAX_LENGTH } from "../dbt-job-rename";
import {
  displayNameError,
  normalizeDisplayName,
  renameSlugError,
} from "../title-rules";
import {
  HOSTILE_SLUGS,
  HOSTILE_TITLES,
  ODD_BUT_VALID_SLUGS,
} from "./scenario-rig";

const KINDS: NamedObjectKind[] = ["flow", "dbt_job"];
const SERVER_MAX: Record<NamedObjectKind, number> = {
  flow: FLOW_NAME_MAX_LENGTH,
  dbt_job: JOB_NAME_MAX_LENGTH,
};

const titles: string[] = [
  ...HOSTILE_TITLES.map(([, title]) => title),
  ...[127, 128, 129, 199, 200, 201].map(n => "x".repeat(n)),
  "\u{1F600}".repeat(100), // 200 UTF-16 units of emoji
  "\u{1F600}".repeat(101),
  "  Padded  ",
  "Café",
  "Café",
  "a​b",
];
const slugs: string[] = [
  ...HOSTILE_SLUGS.map(([, slug]) => slug.trim()),
  ...ODD_BUT_VALID_SLUGS,
  "a".repeat(63),
  "a".repeat(64),
  "a".repeat(65),
  "plain-slug",
  "with--double",
  "trailing-",
  "0123456789ABCDEF01234567",
  "com0",
  "lpt10",
];

describe("the rename dialog's name rules are the server's", () => {
  it("the same caps", () => {
    for (const kind of KINDS) {
      expect(OBJECT_NAME_MAX_LENGTH[kind], kind).toBe(SERVER_MAX[kind]);
    }
  });

  it("the same answer and the same words for every display name", () => {
    for (const kind of KINDS) {
      for (const title of titles) {
        expect(normalizeObjectName(title)).toBe(normalizeDisplayName(title));
        expect(
          objectNameError(kind, title),
          `${kind} ${JSON.stringify(title.slice(0, 40))}`,
        ).toBe(displayNameError(normalizeDisplayName(title), SERVER_MAX[kind]));
      }
    }
  });

  it("the same answer and the same words for every file name", () => {
    for (const kind of KINDS) {
      for (const slug of slugs) {
        expect(
          objectSlugError(kind, slug),
          `${kind} ${JSON.stringify(slug.slice(0, 40))}`,
        ).toBe(renameSlugError(kind, slug));
      }
    }
  });
});

describe("the app rename dialog's rules are the server's", () => {
  const links: string[] = [
    ...HOSTILE_SLUGS.map(([, slug]) => slug),
    ...ODD_BUT_VALID_SLUGS,
    ...RESERVED_APP_SLUGS,
    ...RESERVED_APP_SLUGS.map(s => s.toUpperCase()),
    "traffic-performance",
    "seller-media-buying-3",
    "Sales Board",
    "café",
    "cafe\u0301",
    "отчёт",
    "تقرير",
    "📊",
    "re\u200bport",
    "CON",
    "aux.json",
    "com1",
    "LPT9",
    "com10",
    "console",
    "0123456789abcdef01234567",
    "0123456789ABCDEF01234567",
    "x".repeat(100),
    "x".repeat(101),
    "report.",
    "report ",
    " padded ",
    ".hidden",
    "-dash",
    "a/b",
    "a\\b",
    "a:b",
    "..",
    ".",
    "",
    "   ",
  ];
  const titles: string[] = [
    ...HOSTILE_TITLES.map(([, title]) => title),
    "Traffic Performance",
    "📊 Report",
    "Cafe\u0301 stats",
    "\u200b\u200b",
    "Report\u0000",
    "a\nb",
    "x".repeat(1000),
    "x".repeat(1001),
    "",
  ];

  it("the same answer and the same words for every link and folder name", () => {
    for (const link of links) {
      const label = JSON.stringify(link.slice(0, 40));
      expect(normalizeAppName(link), label).toBe(normalizeName(link));
      expect(appLinkError(link), `link ${label}`).toBe(
        newAppSlugProblem(normalizeName(link)),
      );
      expect(appFolderNameError(link), `folder ${label}`).toBe(
        newSegmentProblem(normalizeName(link)),
      );
    }
  });

  it("the same answer and the same words for every app name", () => {
    for (const title of titles) {
      expect(appNameError(title), JSON.stringify(title.slice(0, 40))).toBe(
        appTitleProblem(normalizeName(title)),
      );
    }
  });

  it("plain words: no storage jargon reaches the dialog", () => {
    for (const link of links) {
      const said = appLinkError(link) ?? "";
      expect(said).not.toMatch(/app folder name|apps API|segment|slug/i);
    }
    expect(appLinkError("link")).toBe(
      "This link is reserved by Mako — pick another.",
    );
    expect(appLinkError("CON")).toBe(
      "Not allowed on Windows: CON — pick another link.",
    );
  });
});
