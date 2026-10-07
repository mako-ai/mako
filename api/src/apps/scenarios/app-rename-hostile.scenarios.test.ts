/**
 * App rename scenarios, part three: the "impossible" ones. Real git and
 * Mongo (./app-scenario-harness.ts).
 *
 *  - hostile names for a slug, a title, a folder and a ref: empty,
 *    whitespace, padded, very long, NFC vs NFD, emoji, RTL, zero-width,
 *    control characters and NUL, path tricks, Windows-invalid characters
 *    and reserved device names, the repo's own folder roots, and names
 *    that look like ids. Each is a clear 400 or a safe normalization —
 *    never a crash, never a path outside `apps/`, never two apps a
 *    checkout cannot tell apart, never a commit for a refusal;
 *  - cycles and chains: a → b → a, a → b then c → a, more renames than
 *    the alias cap, an alias equal to the app's own name;
 *  - scale: history scans and alias lists at realistic upper sizes,
 *    with the measured times printed (and bounded).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Types } from "mongoose";
import { AppIndexEntry, AppIndexHead } from "../../database/workspace-schema";
import {
  HISTORY_SCAN_MAX_COMMITS,
  MAX_ALIASES_PER_APP,
  findAppInSnapshotVia,
  invalidateAppsIndexCache,
  loadAppsIndex,
} from "../app-index.service";
import { parseAppManifest } from "../app-paths";
import {
  createAppFolder,
  createProjectWith,
  moveAppFolder,
  moveProject,
  resolveProjectRef,
} from "../worktree.service";
import { renameObject, resolveObjectRef } from "../../rename/registry";
import { DEFAULT_BRANCH, repoDirFor } from "../repository.service";
import { runGit } from "../git";
import {
  addMember,
  commitsSince,
  externalCommit,
  fileAt,
  headOf,
  manifest,
  newId,
  resetWorkspace,
  startScenarioEnv,
  timed,
  type ScenarioEnv,
} from "./app-scenario-harness";

let env: ScenarioEnv;
beforeAll(async () => {
  env = await startScenarioEnv("app-rename-hostile");
});
afterAll(async () => {
  await env.stop();
});

const WS = new Types.ObjectId().toString();
const ADMIN = new Types.ObjectId().toString();
const D_ID = newId();
const admin = { workspaceId: WS, userId: ADMIN, role: "admin" };

beforeEach(async () => {
  await resetWorkspace(env, WS, {
    "README.md": "workspace\n",
    "apps/a/mako.json": manifest("A"),
    "apps/a/src/main.tsx": "export {};\n",
    "apps/d/mako.json": manifest("D", D_ID),
    "apps/café/mako.json": manifest("Café"),
    "apps/Sales/.gitkeep": "",
  });
  await addMember(WS, ADMIN, "admin");
});

/** Every path in the repo at main. */
async function allPaths(): Promise<string[]> {
  const { stdout } = await runGit([
    "-C",
    repoDirFor(WS),
    "ls-tree",
    "-r",
    "-z",
    "--name-only",
    DEFAULT_BRANCH,
  ]);
  return stdout.split("\0").filter(Boolean);
}

/** A refusal: a RenameError with status 400 (or 409), and no commit. */
async function expectRefused(
  request: { ref: string; slug?: string; title?: string },
  status: 400 | 409 = 400,
) {
  const before = await headOf(WS);
  const paths = await allPaths();
  await expect(
    renameObject(admin, "app", request),
    JSON.stringify(request).slice(0, 80),
  ).rejects.toMatchObject({ name: "RenameError", status });
  expect(await commitsSince(WS, before)).toBe(0);
  expect(await allPaths()).toEqual(paths);
}

// ---------------------------------------------------------------------------
// Hostile names
// ---------------------------------------------------------------------------

describe("hostile slugs", () => {
  it.each([
    ["empty", ""],
    ["whitespace only", "   \t "],
    ["255 chars", "x".repeat(255)],
    ["1000 chars", "x".repeat(1000)],
    ["10000 chars", "x".repeat(10_000)],
    ["emoji", "📊"],
    ["emoji in a name", "report📊"],
    ["zero-width space", "re​port"],
    ["zero-width joiner", "re‍port"],
    ["RTL override", "‮report"],
    ["NUL", "re\u0000port"],
    ["newline", "re\nport"],
    ["tab", "re\tport"],
    ["DEL", "re\u007fport"],
    ["..", ".."],
    [".", "."],
    ["/", "/"],
    ["\\", "\\"],
    ["//", "//"],
    ["leading /", "/x"],
    ["a path", "Sales/x"],
    ["a traversal", "../x"],
    ["backslash traversal", "..\\x"],
    ["~", "~"],
    ["home", "~root"],
    ["%2e%2e", "%2e%2e"],
    ["encoded slash", "a%2Fb"],
    [":", "a:b"],
    ["*", "a*b"],
    ["?", "a?b"],
    ['"', 'a"b'],
    ["<", "a<b"],
    [">", "a>b"],
    ["|", "a|b"],
    ["trailing dot", "x."],
    ["leading dot", ".x"],
    ["ws:x", "ws:x"],
    ["binding:x", "binding:x"],
  ])("%s: refused (400), nothing written", async (_label, slug) => {
    await expectRefused({ ref: "a", slug });
  });

  it.each([
    ["CON", "CON"],
    ["con", "con"],
    ["AUX", "AUX"],
    ["NUL", "NUL"],
    ["nul", "nul"],
    ["PRN", "PRN"],
    ["COM1", "COM1"],
    ["com9", "com9"],
    ["LPT1", "LPT1"],
    ["CON with an extension", "con.txt"],
    ["NUL with an extension", "NUL.json"],
  ])(
    "Windows reserved device name %s: refused (400) — a Windows checkout of the whole repo would fail",
    async (_label, slug) => {
      await expectRefused({ ref: "a", slug });
    },
  );

  it("a name that is merely LIKE a device name is fine (console, com10, nul-report)", async () => {
    for (const slug of ["console", "com10", "nul-report", "auxiliary"]) {
      await renameObject(admin, "app", { ref: "a", slug });
      expect(await fileAt(WS, `apps/${slug}/mako.json`)).not.toBeNull();
      // Back, for the next one (a → slug → a: the alias list stays clean).
      await renameObject(admin, "app", { ref: slug, slug: "a" });
    }
  });

  it("another app's id as a folder name: refused (400) — /apps/<id> opens that other app", async () => {
    await expectRefused({ ref: "a", slug: D_ID });
    // Any 24-hex name reads as an id to every resolver: refused too.
    await expectRefused({ ref: "a", slug: "0123456789abcdef01234567" });
    await expectRefused({ ref: "a", slug: D_ID.toUpperCase() });
    // One pushed from a laptop anyway is linked by its id, never by a name
    // every resolver reads as an id.
    const hex = "0123456789abcdef01234567";
    await externalCommit(WS, { [`apps/${hex}/mako.json`]: manifest("Hex") });
    const found = (await resolveObjectRef(admin, "app", `apps/${hex}`))!;
    expect(found.current.url).toBe(`/apps/${found.id}`);
  });

  it("padded with spaces: trimmed (a safe normalization)", async () => {
    const id = (await resolveObjectRef(admin, "app", "a"))!.id;
    await renameObject(admin, "app", { ref: "a", slug: "  padded  " });
    expect(await fileAt(WS, "apps/padded/mako.json")).not.toBeNull();
    expect((await resolveObjectRef(admin, "app", "padded"))?.id).toBe(id);
  });

  it("NFD and NFC of the same name are ONE name: normalized to NFC, so a twin of apps/café is refused", async () => {
    const nfd = "café";
    expect(nfd).not.toBe("café");
    expect(nfd.normalize("NFC")).toBe("café");
    // apps/café exists (NFC): the NFD spelling is the same name.
    await expectRefused({ ref: "a", slug: nfd }, 409);
    await expectRefused({ ref: "a", slug: "CAFÉ" }, 409);
    // Free, the NFD spelling lands as NFC.
    await renameObject(admin, "app", { ref: "a", slug: "résumé" });
    expect(await fileAt(WS, "apps/résumé/mako.json")).not.toBeNull();
    expect(
      (await allPaths()).some(p => p.includes("é")),
      "no NFD path in git",
    ).toBe(false);
    expect((await resolveObjectRef(admin, "app", "résumé"))?.via).toBe(
      "current",
    );
  });

  it("RTL and non-Latin letters are names like any other", async () => {
    const id = (await resolveObjectRef(admin, "app", "a"))!.id;
    await renameObject(admin, "app", { ref: "a", slug: "تقرير" });
    expect((await resolveObjectRef(admin, "app", "تقرير"))?.id).toBe(id);
    await renameObject(admin, "app", { ref: id, slug: "отчёт" });
    expect(await resolveObjectRef(admin, "app", "تقرير")).toMatchObject({
      id,
      via: "alias",
    });
  });

  it("the repo's own folder roots are plain app names inside apps/ — never the roots themselves", async () => {
    const id = (await resolveObjectRef(admin, "app", "a"))!.id;
    for (const slug of [
      "apps",
      "users",
      "consoles",
      "flows",
      "skills",
      "dbt",
      "connectors",
      "folders",
    ]) {
      await renameObject(admin, "app", { ref: id, slug });
      expect(await fileAt(WS, `apps/${slug}/mako.json`), slug).not.toBeNull();
      expect(await resolveObjectRef(admin, "app", slug)).toMatchObject({
        id,
        via: "current",
        current: { path: `apps/${slug}` },
      });
    }
    // Nothing escaped apps/.
    expect(
      (await allPaths()).filter(
        p =>
          !p.startsWith("apps/") && p !== "README.md" && !p.startsWith(".mako"),
      ),
    ).toEqual([]);
  });
});

describe("hostile titles", () => {
  it.each([
    ["empty", ""],
    ["whitespace only", "  \n\t "],
    ["zero-width only", "​​"],
    ["NUL", "Report\u0000"],
    ["control characters", "Rep\u0007ort"],
    ["a newline", "Report\nInjected: header"],
    ["10000 chars", "x".repeat(10_000)],
  ])("%s: refused (400), nothing written", async (_label, title) => {
    await expectRefused({ ref: "a", title });
  });

  it("emoji, RTL and an NFD title are kept (NFD normalized to NFC), and only mako.json changes", async () => {
    for (const title of ["📊 Report", "تقرير المبيعات", "Café stats"]) {
      const result = await renameObject(admin, "app", { ref: "a", title });
      const written = parseAppManifest(
        await fileAt(WS, "apps/a/mako.json"),
        "a",
      ).title;
      expect(written).toBe(title.normalize("NFC"));
      expect(result.after.title).toBe(title.normalize("NFC"));
    }
  });

  it("an app whose mako.json (pushed from a laptop) has a NUL in its title can still be renamed and moved", async () => {
    await externalCommit(WS, {
      "apps/n/mako.json": `${JSON.stringify({ title: "Bad\u0000name" })}\n`,
    });
    const id = (await resolveObjectRef(admin, "app", "n"))!.id;
    await renameObject(admin, "app", { ref: "n", slug: "n2" });
    await renameObject(admin, "app", { ref: id, title: "Good name" });
    expect(await resolveObjectRef(admin, "app", "n")).toMatchObject({
      id,
      via: "alias",
      current: { path: "apps/n2", title: "Good name" },
    });
  });

  it("a title made of path tricks never becomes a path", async () => {
    await renameObject(admin, "app", { ref: "a", title: "../../users/x" });
    expect(await fileAt(WS, "apps/a/mako.json")).toContain("../../users/x");
    expect((await allPaths()).some(p => p.startsWith("users/"))).toBe(false);
  });
});

describe("hostile names elsewhere: a new app, a folder, a ref", () => {
  it("a new app's title never yields a reserved, id-like or empty folder name", async () => {
    for (const title of ["CON", "nul", D_ID, "📊", "../../etc", "   x   "]) {
      const { project } = await createProjectWith({
        workspaceId: WS,
        title,
        userId: ADMIN,
      });
      const slug = project.path!.split("/").pop()!;
      expect(project.path!.startsWith("apps/"), title).toBe(true);
      expect(/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(slug), slug).toBe(
        false,
      );
      expect(/^[0-9a-f]{24}$/i.test(slug), slug).toBe(false);
    }
  });

  it("a new app's title with a NUL is refused cleanly, and leaves no row behind", async () => {
    const before = await headOf(WS);
    await expect(
      createProjectWith({ workspaceId: WS, title: "Bad\u0000", userId: ADMIN }),
    ).rejects.toMatchObject({ status: 400 });
    expect(await commitsSince(WS, before)).toBe(0);
  });

  it("folder names: traversal, reserved and id-like are refused; nothing outside apps/", async () => {
    const project = (await resolveProjectRef(WS, "a"))!;
    for (const folderSegments of [
      [".."],
      ["CON"],
      ["Sales", "aux"],
      [D_ID],
      ["a/b"],
    ]) {
      const before = await headOf(WS);
      await expect(
        moveProject(
          project,
          { scope: "workspace", folderSegments },
          { userId: ADMIN, role: "admin" },
        ),
        folderSegments.join("/"),
      ).rejects.toMatchObject({ status: 400 });
      await expect(
        createAppFolder(WS, { scope: "workspace", folderSegments }),
      ).rejects.toMatchObject({ status: 400 });
      expect(await commitsSince(WS, before)).toBe(0);
    }
    await expect(
      moveAppFolder(
        WS,
        { scope: "workspace", folderSegments: ["Sales"] },
        { scope: "workspace", folderSegments: ["LPT1"] },
      ),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("an existing folder with a reserved name (pushed from a laptop) can still be moved out of and renamed", async () => {
    await externalCommit(WS, { "apps/con/x/mako.json": manifest("X") });
    const x = (await resolveProjectRef(WS, "apps/con/x"))!;
    await moveProject(
      x,
      { scope: "workspace", folderSegments: ["Sales"] },
      { userId: ADMIN, role: "admin" },
    );
    expect(await fileAt(WS, "apps/Sales/x/mako.json")).not.toBeNull();
    // And an app sitting at a reserved name may leave it.
    await externalCommit(WS, { "apps/aux/mako.json": manifest("Aux") });
    await renameObject(admin, "app", { ref: "aux", slug: "auxiliary" });
    expect(await fileAt(WS, "apps/auxiliary/mako.json")).not.toBeNull();
  });

  it("hostile refs resolve to nothing and never throw", async () => {
    for (const ref of [
      "..",
      "../..",
      "apps/../users",
      "apps/./a/..",
      "%2e%2e",
      "a%2Fb",
      "a\u0000b",
      "\\",
      "//",
      "x".repeat(10_000),
      "users/x/apps/y",
      `users/${ADMIN}/../../apps/a`,
      "ws:a",
      "0".repeat(24),
    ]) {
      expect(await resolveObjectRef(admin, "app", ref), ref).toBeNull();
      expect(await resolveProjectRef(WS, ref), ref.slice(0, 40)).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// Scale
// ---------------------------------------------------------------------------

/** Feed `git fast-import` a stream onto main, after its current tip. */
async function fastImport(
  commits: Array<{ message: string; ops: string[] }>,
): Promise<void> {
  const repoDir = repoDirFor(WS);
  const parent = await headOf(WS);
  const lines: string[] = [];
  let mark = 0;
  const now = 1_780_000_000;
  for (const [i, commit] of commits.entries()) {
    mark += 1;
    lines.push(`commit refs/heads/${DEFAULT_BRANCH}`);
    lines.push(`mark :${mark}`);
    lines.push(`committer Laptop <laptop@example.com> ${now + i} +0000`);
    const msg = Buffer.from(commit.message, "utf8");
    lines.push(`data ${msg.length}`);
    lines.push(commit.message);
    if (i === 0) lines.push(`from ${parent}`);
    lines.push(...commit.ops);
    lines.push("");
  }
  await runGit(["-C", repoDir, "fast-import", "--quiet", "--force"], {
    stdin: `${lines.join("\n")}\n`,
    timeoutMs: 300_000,
  });
  invalidateAppsIndexCache(WS);
}

const inline = (path: string, contents: string) => {
  const bytes = Buffer.byteLength(contents, "utf8");
  return [`M 100644 inline ${path}`, `data ${bytes}`, contents];
};

describe("scale", () => {
  it("2,000 apps: the first index build, a resolve by old name, and a rename stay bounded", async () => {
    const N = 2000;
    const ops: string[] = [];
    for (let i = 0; i < N; i++) {
      const id = new Types.ObjectId().toHexString();
      const folder =
        i % 4 === 0 ? `apps/Team${i % 40}/app-${i}` : `apps/app-${i}`;
      ops.push(
        ...inline(
          `${folder}/mako.json`,
          manifest(`App ${i}`, id, {
            aliases: Array.from(
              { length: MAX_ALIASES_PER_APP },
              (_, k) => `old-${i}-${k}`,
            ),
          }),
        ),
      );
    }
    await fastImport([{ message: "2000 apps", ops }]);
    await AppIndexEntry.deleteMany({ workspaceId: WS });
    await AppIndexHead.deleteMany({ workspaceId: WS });
    invalidateAppsIndexCache();
    const build = await timed(() => loadAppsIndex(WS));
    expect(build.value.apps.length).toBe(N + 3);
    const lookup = await timed(async () => {
      for (let k = 0; k < 200; k++) {
        findAppInSnapshotVia(build.value, `old-${k * 7}-${k % 24}`);
      }
    });
    const rename = await timed(() =>
      renameObject(admin, "app", { ref: "app-1", slug: "app-1-renamed" }),
    );
    const create = await timed(() =>
      createProjectWith({ workspaceId: WS, title: "App 2", userId: ADMIN }),
    );
    console.info(
      `[scale] ${N} apps × ${MAX_ALIASES_PER_APP} aliases: first index build ${build.ms} ms; 200 alias lookups ${lookup.ms} ms; rename ${rename.ms} ms; create ${create.ms} ms`,
    );
    expect(
      (await resolveObjectRef(admin, "app", "old-1-3"))?.current.path,
    ).toBe("apps/app-1-renamed");
    expect(build.ms).toBeLessThan(30_000);
    expect(lookup.ms).toBeLessThan(2_000);
    expect(rename.ms).toBeLessThan(30_000);
    expect(create.ms).toBeLessThan(30_000);
  }, 180_000);

  it("3,000 commits of renames: the history scan is bounded and the newest names are found", async () => {
    // One app renamed 1,500 times (r-0 → r-1 → …), interleaved with 1,500
    // commits elsewhere in the app trees.
    const R_ID = newId();
    const commits: Array<{ message: string; ops: string[] }> = [];
    commits.push({
      message: "create r",
      ops: inline("apps/r-0/mako.json", manifest("R", R_ID)),
    });
    for (let i = 1; i <= 1500; i++) {
      commits.push({
        message: `rename r-${i - 1} → r-${i}`,
        ops: [`R apps/r-${i - 1} apps/r-${i}`],
      });
      commits.push({
        message: `edit d ${i}`,
        ops: inline("apps/d/src/main.tsx", `export const v = ${i};\n`),
      });
    }
    await fastImport(commits);
    await AppIndexEntry.deleteMany({ workspaceId: WS });
    await AppIndexHead.deleteMany({ workspaceId: WS });
    invalidateAppsIndexCache();
    const build = await timed(() => loadAppsIndex(WS));
    const row = build.value.apps.find(a => a.appId === R_ID)!;
    expect(row.path).toBe("apps/r-1500");
    expect(row.aliases.length).toBe(MAX_ALIASES_PER_APP);
    expect(row.aliases[0]).toBe("r-1499");
    expect((await resolveObjectRef(admin, "app", "r-1490"))?.id).toBe(R_ID);
    // An incremental sync after one more commit scans only that commit.
    await externalCommit(WS, { "README.md": "more\n" });
    const incremental = await timed(() => loadAppsIndex(WS));
    console.info(
      `[scale] 3001 commits (${HISTORY_SCAN_MAX_COMMITS}-commit scan cap): first index build ${build.ms} ms; incremental sync ${incremental.ms} ms`,
    );
    expect(build.ms).toBeLessThan(60_000);
    expect(incremental.ms).toBeLessThan(5_000);
  }, 240_000);

  it("a new app among 1,000 taken names counts up to a free one, bounded", async () => {
    const ops: string[] = [];
    for (let i = 1; i <= 1000; i++) {
      const slug = i === 1 ? "report" : `report-${i}`;
      ops.push(...inline(`apps/${slug}/mako.json`, manifest(`R${i}`, newId())));
    }
    await fastImport([{ message: "1000 reports", ops }]);
    const create = await timed(() =>
      createProjectWith({
        workspaceId: WS,
        title: "Report",
        userId: ADMIN,
      }).then(
        () => null,
        (error: unknown) => error,
      ),
    );
    console.info(`[scale] create among 1000 taken names: ${create.ms} ms`);
    // report … report-1000 are all taken: a clear refusal, not a hang.
    expect(create.value).toMatchObject({
      status: 409,
      message: expect.stringMatching(/No free folder name/),
    });
    expect(create.ms).toBeLessThan(30_000);
  }, 120_000);
});
