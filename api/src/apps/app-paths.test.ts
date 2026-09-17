import assert from "node:assert/strict";
import {
  appKeyOf,
  appRepoPath,
  derivedAppId,
  isSafeSegment,
  parseAppFolderPath,
  parseAppManifest,
  parseAppRepoPath,
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

console.log("app-paths: ok");
