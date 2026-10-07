/**
 * Console names nobody should type — and some people will: empty,
 * whitespace, padded, very long, unicode in two normal forms, emoji, RTL,
 * zero-width, control characters and NUL, path tricks, Windows-invalid
 * characters and reserved names, folder roots, id look-alikes, and names
 * that end in a console extension.
 *
 * Every entry point that names a console (rename_object title and slug,
 * the explorer's rename and Move-to name, a first save's path, POST /,
 * the folder routes) must answer either a clear 400/409 — nothing
 * changed — or a safe normalization, and then the invariants hold:
 * the row's name IS its file's name (a sync never renames it later), the
 * file is inside the console tree of its scope, the language its
 * extension says, and no two consoles a checkout cannot tell apart
 * (letter case, Unicode normal form) — never a 500.
 */
import { describe, expect, it, vi } from "vitest";
import { Types } from "mongoose";

const who = vi.hoisted(() => ({ id: "", role: "member" as string | null }));

vi.mock("../../auth/unified-auth.middleware", () => ({
  unifiedAuthMiddleware: async (
    c: { set: (k: string, v: unknown) => void },
    next: () => Promise<void>,
  ) => {
    c.set("authType", "session");
    c.set("user", { id: who.id, email: "u@example.com" });
    await next();
  },
  isSessionAuth: () => true,
}));
vi.mock("../../services/workspace.service", () => ({
  workspaceService: {
    hasAccess: async () => who.role !== null,
    getMember: async () => (who.role ? { role: who.role } : null),
    getMembers: async () => [],
    hasRole: async (_ws: string, _user: string, roles: string[]) =>
      who.role !== null && roles.includes(who.role),
  },
}));
vi.mock("../../inngest", () => ({
  inngest: { send: async () => ({}), createFunction: () => ({}) },
}));

import { ConsoleFolder, SavedConsole } from "../../database/workspace-schema";
import { parseConsoleRepoPath, safeSegment } from "../../apps/console-files";
import { syncConsolesIndexFromRepo } from "../../apps/workspace-consoles.service";
import { renameObject } from "../../rename/registry";
import { RenameError } from "../../rename/types";
import { createConsoleRig } from "./console-scenario-rig";

const rig = createConsoleRig(who, "console-hostile-scenarios");
const { owner, member } = rig.people;

const LONG = (n: number) => "x".repeat(n);

/**
 * What each hostile name becomes: refused (`null`), or the name it is
 * stored and filed as.
 */
const NAMES: Array<[label: string, input: string, becomes: string | null]> = [
  ["empty", "", null],
  ["whitespace only", "   \t ", null],
  ["leading/trailing spaces", "  padded  ", "padded"],
  ["inner whitespace run", "two   spaces", "two spaces"],
  ["120 chars", LONG(120), LONG(120)],
  ["255 chars", LONG(255), null],
  ["1000 chars", LONG(1000), null],
  ["10000 chars", LONG(10000), null],
  ["NFD é", "café", "café"],
  ["emoji", "📊 revenue", "📊 revenue"],
  ["RTL", "تقرير المبيعات", "تقرير المبيعات"],
  ["zero-width space", "re​port", "report"],
  ["BOM", "﻿report", "report"],
  ["control char", "a\u0001b", "a b"],
  ["NUL", "a\u0000b", "a b"],
  ["newline", "line\nbreak", "line break"],
  ["dot-dot", "..", null],
  ["dot", ".", null],
  ["leading dot", ".hidden", null],
  [".git", ".git", null],
  ["trailing dot", "trailing.", null],
  ["backslash", "a\\b", null],
  ["colon", "Q1: revenue", null],
  ["star", "a*b", null],
  ["question mark", "why?", null],
  ["double quote", 'say "hi"', null],
  ["angle brackets", "<b>", null],
  ["pipe", "a|b", null],
  ["reserved CON", "CON", null],
  ["reserved nul (any case)", "nul", null],
  ["reserved COM1 with extension", "COM1.backup", null],
  ["reserved AUX", "aux", null],
  ["tilde", "~", "~"],
  ["percent-encoded dots", "%2e%2e", "%2e%2e"],
  ["percent-encoded slash", "a%2Fb", "a%2Fb"],
  ["a folder root", "consoles", "consoles"],
  ["another root", "users", "users"],
  ["apps root", "apps", "apps"],
  [
    "24-hex id look-alike",
    "507f1f77bcf86cd799439011",
    "507f1f77bcf86cd799439011",
  ],
  ["an extension in the name", "q.sql", "q.sql"],
  ["a sidecar look-alike", "q.chart", "q.chart"],
];

/** The invariants every accepted name must keep, now and after a sync. */
async function expectSound(id: string, name: string, ws = rig.ws) {
  const row = (await rig.row(id))!;
  expect(row.name).toBe(name);
  const loc = parseConsoleRepoPath(row.path ?? "");
  expect(loc, `path ${row.path}`).not.toBeNull();
  expect(loc!.name).toBe(name);
  expect(loc!.language).toBe(row.language ?? "sql");
  expect(
    row.access === "private"
      ? row.path!.startsWith(`users/${row.owner_id}/consoles/`)
      : row.path!.startsWith("consoles/"),
  ).toBe(true);
  expect(await rig.fileAt(row.path!, ws)).not.toBeNull();
  // The sync reads the name back from the file: it must not change.
  await rig.laptop(
    {
      writes: {
        [row.path!]: `${(await rig.fileAt(row.path!, ws))!}-- touched\n`,
      },
    },
    { ws },
  );
  const again = (await rig.row(id))!;
  expect(again.name).toBe(name);
  expect(again.path).toBe(row.path);
  expect(again.is_deleted).toBeFalsy();
  for (const p of await rig.treePaths(ws)) {
    expect(
      p === "README.md" ||
        p.startsWith("consoles/") ||
        /^users\/[A-Za-z0-9_-]+\/consoles\//.test(p),
      p,
    ).toBe(true);
  }
}

async function renameStatus(p: Promise<unknown>): Promise<number> {
  try {
    const r = (await p) as { status?: number };
    return typeof r?.status === "number" ? r.status : 200;
  } catch (error) {
    if (error instanceof RenameError) return error.status;
    throw error;
  }
}

describe.each(NAMES)("%s", (_label, input, becomes) => {
  it("rename_object title", async () => {
    const c = await rig.save("start", owner);
    const id = c._id.toString();
    const before = await rig.snapshot();
    const code = await renameStatus(
      renameObject(rig.ctx(owner), "console", { ref: id, title: input }),
    );
    if (becomes === null) {
      expect(code).toBe(400);
      expect(await rig.snapshot()).toEqual(before);
    } else {
      expect(code).toBe(200);
      await expectSound(id, becomes);
    }
  });

  it("the explorer's rename (PATCH /:id/rename)", async () => {
    const c = await rig.save("start", owner);
    const id = c._id.toString();
    const before = await rig.snapshot();
    const r = await rig.api("PATCH", `/consoles/${id}/rename`, owner, {
      name: input,
    });
    if (becomes === null) {
      expect(r.status, JSON.stringify(r.body)).toBe(400);
      expect(await rig.snapshot()).toEqual(before);
    } else {
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      await expectSound(id, becomes);
    }
  });

  it("a first save (PUT with a path) and POST /", async () => {
    const id = new Types.ObjectId().toString();
    const before = await rig.snapshot();
    // An empty path is "no path" to the editor's save (it saves the tab's
    // title, "Untitled" by default) — not a name to judge.
    const r =
      input === ""
        ? null
        : await rig.api("PUT", `/consoles/${id}`, owner, {
            content: "SELECT 1\n",
            isSaved: true,
            path: input,
            access: "workspace",
          });
    // In the other workspace: POST's conflict dialog is scope-blind (a
    // workspace console of that name is a conflict to show) — not what
    // this checks.
    const p = await rig.api(
      "POST",
      "/consoles",
      owner,
      { path: input, content: "SELECT 2\n", access: "private" },
      rig.ws2,
    );
    if (becomes === null) {
      if (r) expect(r.status, JSON.stringify(r.body)).toBe(400);
      expect(p.status, JSON.stringify(p.body)).toBe(400);
      expect(await rig.snapshot()).toEqual(before);
    } else {
      expect(r?.status, JSON.stringify(r?.body)).toBe(200);
      expect(p.status, JSON.stringify(p.body)).toBe(201);
      await expectSound(id, becomes);
      await expectSound((p.body.data as { id: string }).id, becomes, rig.ws2);
    }
  });

  it("as a folder name (New folder, a moving slug)", async () => {
    const r = await rig.api("POST", "/consoles/folders", owner, {
      name: input,
      access: "workspace",
    });
    const c = await rig.save("start", owner);
    const id = c._id.toString();
    // `consoles/…` and `users/…` slugs are FULL repo paths (documented in
    // the handler), never a folder of that name: those two are judged as
    // folder names by the folder route only.
    const rootSlug = input === "consoles" || input === "users";
    const code = rootSlug
      ? 200
      : await renameStatus(
          renameObject(rig.ctx(owner), "console", {
            ref: id,
            slug: `${input}/start`,
          }),
        );
    if (becomes === null) {
      expect(r.status, JSON.stringify(r.body)).toBe(400);
      // A slug of only slashes and spaces names no folder: either refused
      // or the console's own place (nothing to do).
      expect([400, 200]).toContain(code);
      expect((await rig.row(id))!.path).toBe("consoles/start.sql");
    } else {
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      expect((r.body.data as { name: string }).name).toBe(becomes);
      expect(code).toBe(200);
      if (rootSlug) return;
      const row = (await rig.row(id))!;
      expect(row.path).toBe(`consoles/${becomes}/start.sql`);
      const folder = await ConsoleFolder.findById(row.folderId);
      expect(folder?.name).toBe(becomes);
      await expectSound(id, "start");
    }
  });
});

describe("one name, however it is spelled", () => {
  it("NFC and NFD of the same name are one console name", async () => {
    await rig.save("café", owner);
    const other = await rig.save("other", owner);
    const code = await renameStatus(
      renameObject(rig.ctx(owner), "console", {
        ref: other._id.toString(),
        title: "café",
      }),
    );
    expect(code).toBe(409);
    const r = await rig.api("PATCH", `/consoles/${other._id}/rename`, owner, {
      name: "CAFÉ",
    });
    expect(r.status).toBe(409);
    expect(await rig.consolePaths()).toEqual([
      "consoles/café.sql",
      "consoles/other.sql",
    ]);
  });

  it("a NEW console (first save, POST /, a duplicate) never lands on a case or Unicode twin", async () => {
    await rig.save("Caf\u00e9 Report", owner);
    const before = await rig.consolePaths();
    for (const path of [
      "café report",
      "CAFE\u0301 REPORT",
      "Cafe\u0301 Report",
    ]) {
      const put = await rig.api(
        "PUT",
        `/consoles/${new Types.ObjectId()}`,
        owner,
        { content: "SELECT 1\n", isSaved: true, path, access: "workspace" },
      );
      expect(put.status, `${path}: ${JSON.stringify(put.body)}`).toBe(409);
      const post = await rig.api("POST", "/consoles", member, {
        path,
        content: "SELECT 2\n",
        access: "workspace",
      });
      expect([409], `${path}: ${JSON.stringify(post.body)}`).toContain(
        post.status,
      );
    }
    expect(await rig.consolePaths()).toEqual(before);
    // A duplicate's free name skips an NFD twin a laptop pushed into the
    // copier's tree.
    await rig.laptop({
      writes: {
        [`users/${owner.id}/consoles/Cafe\u0301 Report copy.sql`]:
          "SELECT 'laptop'\n",
      },
    });
    const dup = await rig.api(
      "POST",
      `/consoles/${(await SavedConsole.findOne({ path: "consoles/Caf\u00e9 Report.sql" }))!._id}/duplicate`,
      owner,
    );
    expect(dup.status, JSON.stringify(dup.body)).toBe(201);
    expect((await rig.row((dup.body.data as { id: string }).id))!.path).toBe(
      `users/${owner.id}/consoles/Caf\u00e9 Report copy (2).sql`,
    );
  });

  it("a name that a laptop pushed in NFD still blocks its NFC twin", async () => {
    await rig.adopt();
    await rig.laptop({ writes: { "consoles/café.sql": "SELECT 1\n" } });
    const other = await rig.save("other", owner);
    const code = await renameStatus(
      renameObject(rig.ctx(owner), "console", {
        ref: other._id.toString(),
        title: "café",
      }),
    );
    expect(code).toBe(409);
    expect(await rig.consolePaths()).toEqual([
      "consoles/café.sql",
      "consoles/other.sql",
    ]);
  });

  it("a folder whose name differs only in case is the same folder: no twin is made", async () => {
    const a = await rig.save("x", owner);
    await renameObject(rig.ctx(owner), "console", {
      ref: a._id.toString(),
      slug: "Team/x",
    });
    const b = await rig.save("y", owner);
    // A move into "team/…" (a twin of "Team") is refused, never a second
    // directory that a macOS / Windows checkout folds into the first.
    const code = await renameStatus(
      renameObject(rig.ctx(owner), "console", {
        ref: b._id.toString(),
        slug: "team/y",
      }),
    );
    expect(code).toBe(409);
    const r = await rig.api("PATCH", `/consoles/${b._id}/rename`, owner, {
      name: "TEAM/y",
    });
    expect(r.status).toBe(409);
    const f = await rig.api("POST", "/consoles/folders", owner, {
      name: "team",
      access: "workspace",
    });
    expect(f.status).toBe(409);
    expect(
      (await ConsoleFolder.find({ workspaceId: rig.ws })).map(x => x.name),
    ).toEqual(["Team"]);
    expect(await rig.consolePaths()).toEqual([
      "consoles/Team/x.sql",
      "consoles/y.sql",
    ]);
    // The same name in ANOTHER scope (a private "team" of the owner) is
    // not a twin: a different tree.
    const priv = await rig.save("z", owner, { access: "private" });
    await renameObject(rig.ctx(owner), "console", {
      ref: priv._id.toString(),
      slug: "team/z",
    });
    expect((await rig.row(priv._id))!.path).toBe(
      `users/${owner.id}/consoles/team/z.sql`,
    );
  });

  it("a console in a laptop-made folder twin still refuses its case twin", async () => {
    await rig.adopt();
    await rig.laptop(
      {
        writes: {
          "consoles/Team/x.sql": "SELECT 'Team x'\n",
          "consoles/team/w.sql": "SELECT 'team w'\n",
        },
      },
      { pusher: owner.id },
    );
    const w = await SavedConsole.findOne({ path: "consoles/team/w.sql" });
    const code = await renameStatus(
      renameObject(rig.ctx(owner), "console", {
        ref: w!._id.toString(),
        title: "X",
      }),
    );
    expect(code).toBe(409);
    expect((await rig.row(w!._id))!.path).toBe("consoles/team/w.sql");
  });

  it("a JavaScript console's name never makes its file read as a MongoDB console", async () => {
    const js = await rig.manager.saveConsole(
      "script",
      "return 1;\n",
      rig.ws,
      owner.id,
      undefined,
      undefined,
      undefined,
      { access: "workspace", language: "javascript" },
    );
    expect(js.path).toBe("consoles/script.js");
    const code = await renameStatus(
      renameObject(rig.ctx(owner), "console", {
        ref: js._id.toString(),
        title: "script.mongodb",
      }),
    );
    expect(code).toBe(400);
    expect((await rig.row(js._id))!.path).toBe("consoles/script.js");
    await syncConsolesIndexFromRepo(rig.ws);
    expect((await rig.row(js._id))!.language).toBe("javascript");
  });

  it("names at the length limit still get a free name: a second duplicate, a restore beside a namesake (never a hang)", async () => {
    const name = `${LONG(118)}📊`; // 120 UTF-16 units, an emoji at the end
    const c = await rig.save(name, owner);
    const first = await rig.api("POST", `/consoles/${c._id}/duplicate`, owner);
    const second = await rig.api("POST", `/consoles/${c._id}/duplicate`, owner);
    expect(first.status).toBe(201);
    expect(second.status, JSON.stringify(second.body)).toBe(201);
    const a = (await rig.row((first.body.data as { id: string }).id))!;
    const b = (await rig.row((second.body.data as { id: string }).id))!;
    expect(a.path).not.toBe(b.path);
    for (const row of [a, b]) {
      expect(parseConsoleRepoPath(row.path!)!.name).toBe(row.name);
      expect(row.name.length).toBeLessThanOrEqual(120);
      // No lone surrogate (half an emoji) in the name.
      expect(
        /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(
          row.name,
        ),
      ).toBe(false);
    }
    // Trash it, take its name, restore it: it comes back beside.
    expect((await rig.api("DELETE", `/consoles/${c._id}`, owner)).status).toBe(
      200,
    );
    await rig.save(name, owner);
    const restored = await rig.api(
      "PATCH",
      `/consoles/${c._id}/restore`,
      owner,
    );
    expect(restored.status, JSON.stringify(restored.body)).toBe(200);
    const back = (await rig.row(c._id))!;
    expect(back.path).not.toBe(`consoles/${name}.sql`);
    expect(parseConsoleRepoPath(back.path!)!.name).toBe(back.name);
    expect(back.name.endsWith(" (2)")).toBe(true);
  });

  it("a file name is cut on a code point: never half an emoji in a path", () => {
    // A name over the limit can still reach the file-name rule (a row
    // older than the rule, a derived name): its cut must keep emoji whole.
    const name = `${LONG(119)}📊📊`;
    const segment = safeSegment(name);
    expect(segment).toBe(LONG(119));
    expect(safeSegment(`${LONG(118)}📊📊`)).toBe(`${LONG(118)}📊`);
  });

  it("a duplicate of a console with a name at the length limit is named as its file", async () => {
    const c = await rig.save(LONG(120), owner);
    const r = await rig.api("POST", `/consoles/${c._id}/duplicate`, owner);
    expect(r.status).toBe(201);
    const copyId = (r.body.data as { id: string }).id;
    const copy = (await rig.row(copyId))!;
    expect(parseConsoleRepoPath(copy.path!)!.name).toBe(copy.name);
    await expectSound(copyId, copy.name);
  });
});
