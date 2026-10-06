import assert from "node:assert/strict";
import {
  addManifestAliases,
  appKeyOf,
  appRepoPath,
  derivedAppId,
  isSafeSegment,
  parseAppAliases,
  parseAppFolderPath,
  parseAppManifest,
  parseAppRepoPath,
  setManifestTitle,
  stampManifestId,
} from "./app-paths";

// Paths -------------------------------------------------------------------

assert.deepEqual(parseAppRepoPath("apps/report"), {
  scope: "workspace",
  ownerId: undefined,
  folderSegments: [],
  slug: "report",
});
assert.deepEqual(parseAppRepoPath("apps/Sales/CH/daily tracker"), {
  scope: "workspace",
  ownerId: undefined,
  folderSegments: ["Sales", "CH"],
  slug: "daily tracker",
});
assert.deepEqual(parseAppRepoPath("users/6846e6a01b05af0948070583/apps/x"), {
  scope: "private",
  ownerId: "6846e6a01b05af0948070583",
  folderSegments: [],
  slug: "x",
});
assert.equal(parseAppRepoPath("apps"), null);
assert.equal(parseAppRepoPath("consoles/report"), null);
assert.equal(parseAppRepoPath("users/abc/consoles/x"), null);
assert.equal(parseAppRepoPath("apps/../etc"), null);
assert.equal(parseAppRepoPath("apps/.hidden"), null);
assert.equal(parseAppRepoPath("apps/a//b"), null);

assert.equal(
  appRepoPath({ scope: "workspace", folderSegments: ["Sales"], slug: "r" }),
  "apps/Sales/r",
);
assert.equal(
  appRepoPath({
    scope: "private",
    ownerId: "u1",
    folderSegments: [],
    slug: "scratch",
  }),
  "users/u1/apps/scratch",
);
assert.throws(() =>
  appRepoPath({ scope: "workspace", folderSegments: [".."], slug: "r" }),
);
assert.throws(() =>
  appRepoPath({ scope: "private", folderSegments: [], slug: "r" }),
);

assert.deepEqual(parseAppFolderPath("apps"), {
  scope: "workspace",
  folderSegments: [],
});
assert.deepEqual(parseAppFolderPath("users/u1/apps"), {
  scope: "private",
  ownerId: "u1",
  folderSegments: [],
});
assert.deepEqual(parseAppFolderPath("apps/Sales/CH"), {
  scope: "workspace",
  ownerId: undefined,
  folderSegments: ["Sales", "CH"],
});
assert.equal(parseAppFolderPath("dbt/models"), null);

// Identity ----------------------------------------------------------------

// The key of a top-level app is its bare slug, so pre-existing apps keep the
// ids their deployments and binding artifacts are already filed under.
assert.equal(appKeyOf("apps/report"), "report");
assert.equal(appKeyOf("apps/Sales/report"), "Sales/report");
assert.equal(appKeyOf("users/u1/apps/report"), "users/u1/apps/report");

const ws = "6a9411eb4c8b33609a65e666";
assert.equal(
  derivedAppId(ws, "report").toHexString(),
  derivedAppId(ws, appKeyOf("apps/report")).toHexString(),
);
assert.notEqual(
  derivedAppId(ws, "report").toHexString(),
  derivedAppId(ws, "Sales/report").toHexString(),
);

// Manifest ----------------------------------------------------------------

const parsed = parseAppManifest(
  JSON.stringify({
    id: "6A9411EB4C8B33609A65E665",
    title: "Report",
    description: "d",
    entry: "src/main.tsx",
  }),
  "report",
);
assert.equal(parsed.id, "6a9411eb4c8b33609a65e665");
assert.equal(parsed.title, "Report");
assert.equal(parsed.description, "d");
assert.equal(parsed.raw.entry, "src/main.tsx");

// Malformed or partial manifests never hide the app.
assert.deepEqual(parseAppManifest("{not json", "report").title, "report");
assert.equal(parseAppManifest(null, "report").id, undefined);
assert.equal(parseAppManifest('{"id":"nope"}', "r").id, undefined);
assert.equal(parseAppManifest('{"title":"  "}', "r").title, "r");

const stamped = stampManifestId(
  '{\n  "schemaVersion": 1,\n  "title": "Report"\n}\n',
  "6a9411eb4c8b33609a65e665",
);
assert.equal(
  stamped,
  '{\n  "id": "6a9411eb4c8b33609a65e665",\n  "schemaVersion": 1,\n  "title": "Report"\n}\n',
);
// Already stamped: untouched, byte for byte.
assert.equal(stampManifestId(stamped, "6a9411eb4c8b33609a65e665"), stamped);
// Unparseable: left alone rather than overwritten.
assert.equal(stampManifestId("{oops", "6a9411eb4c8b33609a65e665"), null);
// Replaces a stale id.
assert.match(
  stampManifestId(
    '{"id":"000000000000000000000000"}',
    "6a9411eb4c8b33609a65e665",
  ) ?? "",
  /6a9411eb4c8b33609a65e665/,
);

// Folder names are Unicode: apps/café is an app people already have.
assert.equal(isSafeSegment("café"), true);
assert.equal(isSafeSegment("日本語 report"), true);
assert.equal(isSafeSegment("a/b"), false);
assert.equal(isSafeSegment(".hidden"), false);
assert.equal(parseAppRepoPath("apps/café")?.slug, "café");

// Aliases ------------------------------------------------------------------

// Normalized, deduplicated, and anything unusable set aside (never fatal).
assert.deepEqual(parseAppAliases(undefined), { aliases: [], rejected: [] });
assert.deepEqual(parseAppAliases("report"), {
  aliases: [],
  rejected: ["report"],
});
assert.deepEqual(
  parseAppAliases([
    " old-name ",
    "/apps/Sales/old/",
    "old-name",
    "",
    7,
    "a/../b",
  ]),
  { aliases: ["old-name", "apps/Sales/old"], rejected: ["", 7, "a/../b"] },
);
assert.deepEqual(
  parseAppManifest('{"title":"X","aliases":["one","two"]}', "x").aliases,
  ["one", "two"],
);
assert.deepEqual(parseAppManifest('{"title":"X"}', "x").aliases, []);

// addManifestAliases: append, dedupe, drop the app's current names, keep
// everything else where it is, and refuse an unparseable manifest.
const withAliases = addManifestAliases(
  '{\n  "id": "5ae23997208465e4541cd59d",\n  "title": "X",\n  "entry": "src/main.tsx"\n}\n',
  ["old", "apps/Sales/old"],
  ["x", "apps/x"],
);
assert.deepEqual(JSON.parse(withAliases!), {
  id: "5ae23997208465e4541cd59d",
  title: "X",
  entry: "src/main.tsx",
  aliases: ["old", "apps/Sales/old"],
});
// Already recorded: the contents come back untouched (same string).
assert.equal(addManifestAliases(withAliases, ["old"]), withAliases);
// The app's own current name is noise and is dropped, even if it was there.
assert.deepEqual(
  JSON.parse(addManifestAliases(withAliases, ["x"], ["x"])!).aliases,
  ["old", "apps/Sales/old"],
);
// Dropping the last alias removes the key rather than leaving `[]`.
assert.equal(
  "aliases" in
    JSON.parse(addManifestAliases('{"title":"X","aliases":["x"]}', [], ["x"])!),
  false,
);
assert.equal(addManifestAliases("{not json", ["old"]), null);
assert.equal(addManifestAliases("[1,2]", ["old"]), null);
// A missing manifest becomes a minimal one (the move stamps the id first).
assert.deepEqual(JSON.parse(addManifestAliases(null, ["old"])!), {
  aliases: ["old"],
});

// setManifestTitle: in place when present, after the id when not, and
// never over a file it could not read.
assert.deepEqual(
  JSON.parse(
    setManifestTitle(
      '{"id":"5ae23997208465e4541cd59d","title":"X","entry":"e"}',
      "Y",
    )!,
  ),
  { id: "5ae23997208465e4541cd59d", title: "Y", entry: "e" },
);
assert.deepEqual(
  Object.keys(
    JSON.parse(
      setManifestTitle('{"id":"5ae23997208465e4541cd59d","entry":"e"}', "Y")!,
    ),
  ),
  ["id", "title", "entry"],
);
assert.deepEqual(
  Object.keys(JSON.parse(setManifestTitle('{"entry":"e"}', "Y")!)),
  ["title", "entry"],
);
const same = '{"title":"Y"}';
assert.equal(setManifestTitle(same, "Y"), same);
assert.equal(setManifestTitle("{oops", "Y"), null);

console.log("app-paths.test.ts: ok");
