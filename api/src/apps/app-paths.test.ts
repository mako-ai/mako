import assert from "node:assert/strict";
import {
  appKeyOf,
  appNameProblem,
  appRepoPath,
  derivedAppId,
  isSafeSegment,
  parseAppFolderPath,
  parseAppManifest,
  parseAppRepoPath,
  renameManifest,
  stampManifestId,
  stripManifestAliases,
} from "./app-paths";

// Paths -------------------------------------------------------------------

assert.deepEqual(parseAppRepoPath("apps/report"), {
  scope: "workspace",
  ownerHandle: undefined,
  folderSegments: [],
  slug: "report",
});
assert.deepEqual(parseAppRepoPath("apps/Sales/CH/daily tracker"), {
  scope: "workspace",
  ownerHandle: undefined,
  folderSegments: ["Sales", "CH"],
  slug: "daily tracker",
});
// A personal tree is named by a handle; the parser returns it raw — who it
// belongs to is the OwnerDirectory's answer, never the folder's (see
// user-handles.test.ts).
assert.deepEqual(parseAppRepoPath("users/joan.rodriguez/apps/x"), {
  scope: "private",
  ownerHandle: "joan.rodriguez",
  folderSegments: [],
  slug: "x",
});
assert.deepEqual(
  parseAppRepoPath("users/joan-2/apps/Sales/x")?.ownerHandle,
  "joan-2",
);
// Not a handle: uppercase, a leading dot, traversal — not an app location.
assert.equal(parseAppRepoPath("users/Joan/apps/x"), null);
assert.equal(parseAppRepoPath("users/.joan/apps/x"), null);
assert.equal(parseAppRepoPath("users/../apps/x"), null);
assert.equal(parseAppRepoPath("users/joan./apps/x"), null);
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
    ownerHandle: "joan",
    folderSegments: [],
    slug: "scratch",
  }),
  "users/joan/apps/scratch",
);
assert.throws(() =>
  appRepoPath({
    scope: "private",
    ownerHandle: "../joan",
    folderSegments: [],
    slug: "r",
  }),
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
assert.deepEqual(parseAppFolderPath("users/joan/apps"), {
  scope: "private",
  ownerHandle: "joan",
  folderSegments: [],
});
assert.equal(parseAppFolderPath("users/Joan/apps"), null);
assert.deepEqual(parseAppFolderPath("apps/Sales/CH"), {
  scope: "workspace",
  ownerHandle: undefined,
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

// Old links (`aliases`) --------------------------------------------------

// Cleaned on the way in: trimmed, NFC, no slash at either end, each once;
// anything unusable is dropped and never hides the app.
assert.deepEqual(
  parseAppManifest(
    JSON.stringify({
      title: "T",
      aliases: [" old ", "/apps/S/x/", "old", "cafe\u0301", "../up", "", 3],
    }),
    "t",
  ).aliases,
  ["old", "apps/S/x", "caf\u00e9"],
);
assert.deepEqual(parseAppManifest('{"aliases":"old"}', "t").aliases, []);
assert.deepEqual(parseAppManifest("{oops", "t").aliases, []);

// A rename appends the old link, keeps every other key where it was, and
// never lists the app's current slug or path.
const MANIFEST =
  '{\n  "id": "6a9411eb4c8b33609a65e665",\n  "entry": "src/main.tsx"\n}\n';
assert.equal(
  renameManifest(MANIFEST, {
    title: "Report",
    addAliases: ["old"],
    currentNames: ["new", "apps/new"],
  }),
  '{\n  "id": "6a9411eb4c8b33609a65e665",\n  "title": "Report",\n  "entry": "src/main.tsx",\n  "aliases": [\n    "old"\n  ]\n}\n',
);
const renamedBack = renameManifest('{"title":"A","aliases":["a","b"],"z":1}', {
  addAliases: ["c"],
  currentNames: ["a", "apps/a"],
});
assert.deepEqual(JSON.parse(renamedBack ?? ""), {
  title: "A",
  aliases: ["b", "c"],
  z: 1,
});
// Renamed back to its only old name: the key goes rather than staying empty.
assert.equal(
  renameManifest('{"title":"A","aliases":["a"]}', { currentNames: ["a"] }),
  '{\n  "title": "A"\n}\n',
);
// The newest 24 are kept.
const capped = JSON.parse(
  renameManifest(
    JSON.stringify({ aliases: Array.from({ length: 24 }, (_, i) => `n${i}`) }),
    { addAliases: ["n24"] },
  ) ?? "",
) as { aliases: string[] };
assert.equal(capped.aliases.length, 24);
assert.deepEqual([capped.aliases[0], capped.aliases[23]], ["n1", "n24"]);
// Unparseable: never written over.
assert.equal(renameManifest("{oops", { title: "T" }), null);
assert.equal(stripManifestAliases("{oops"), null);
assert.equal(stripManifestAliases(MANIFEST), MANIFEST);
assert.equal(
  stripManifestAliases('{"title":"A","aliases":["a"]}'),
  '{\n  "title": "A"\n}\n',
);

// New names ----------------------------------------------------------------

// What may be chosen as a link or a folder name, in plain words.
assert.equal(appNameProblem("daily tracker v2"), null);
assert.equal(appNameProblem("caf\u00e9"), null);
assert.equal(appNameProblem("x".repeat(100)), null);
assert.match(appNameProblem("x".repeat(101)) ?? "", /100 characters/);
assert.match(appNameProblem("") ?? "", /Give the app a link/);
assert.match(appNameProblem("", "folder") ?? "", /Give the folder a name/);
assert.match(appNameProblem("a/b") ?? "", /Use only letters/);
assert.match(appNameProblem(".hidden") ?? "", /Start the link with/);
assert.match(appNameProblem("ends.") ?? "", /can't end with a dot/);
for (const device of ["con", "NUL", "com1", "lpt9", "aux.json"]) {
  assert.match(appNameProblem(device) ?? "", /Windows/, device);
  assert.match(appNameProblem(device, "folder") ?? "", /Windows/, device);
  // Discovery still lists a folder a laptop already pushed.
  assert.equal(isSafeSegment(device), true, device);
}
assert.equal(appNameProblem("console"), null);
assert.match(appNameProblem("6A9411EB4C8B33609A65E665") ?? "", /app id/);
// The words the apps routes keep are refused as a link, not as a folder.
assert.match(appNameProblem("Search") ?? "", /reserved/);
assert.equal(appNameProblem("search", "folder"), null);
// Never how Mako stores it.
for (const bad of ["", "a/b", "con", "search", "x".repeat(101), ".x", "y."]) {
  assert.doesNotMatch(
    appNameProblem(bad) ?? "",
    /folder name|apps API|segment|slug/i,
    bad,
  );
}
// appRepoPath refuses in the same words.
assert.throws(
  () => appRepoPath({ scope: "workspace", folderSegments: ["a/b"], slug: "x" }),
  /Use only letters/,
);

console.log("app-paths: ok");
