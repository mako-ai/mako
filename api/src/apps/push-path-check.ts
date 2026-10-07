/**
 * The app-folder check a NETWORK push goes through (the git endpoint's
 * pre-receive hook, routes/apps-git.ts).
 *
 * Mako refuses, on every path it writes itself (rename, move, create), an
 * app folder name a checkout cannot hold: two names one case-insensitive or
 * normalization-insensitive disk (macOS, Windows) cannot tell apart, a
 * Windows device name or character, a name not in Unicode NFC. A push from a
 * laptop or a sandbox terminal used to bring any of them in. This is the
 * same rule for that door — applied only to app folders the push INTRODUCES:
 * a folder already on main (or already on the pushed branch) is history,
 * and history never blocks a push.
 *
 * It runs as its own Node process (the hook is a shell script spawned by
 * `git http-backend`), so it ships as source text, self-contained CommonJS
 * with no imports beyond Node's own. `check` is pure and exported for tests.
 */
export const PUSH_PATH_CHECK_FILE = "mako-app-paths.cjs";

export const PUSH_PATH_CHECK_SCRIPT = String.raw`"use strict";
// Written by Mako (apps/push-path-check.ts). Reads the pre-receive updates
// on stdin; refuses a push that introduces an app folder a checkout cannot
// hold. Exit 1 with "mako:" lines on stderr; 0 otherwise.
const ZERO = "0".repeat(40);
const MANIFEST = "mako.json";
const DEVICE = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;
const INVALID = /[:*?"<>|\\\u0000-\u001f]/;

/** The tree root an app path sits under ("apps" or "users/<id>/apps"), or null. */
function rootOf(path) {
  const s = path.split("/");
  if (s[0] === "apps" && s.length >= 2) return "apps";
  if (s[0] === "users" && s.length >= 4 && s[2] === "apps") {
    return s.slice(0, 3).join("/");
  }
  return null;
}

/** App folders in a list of file paths: outermost folders holding mako.json. */
function appDirs(files) {
  const dirs = [];
  for (const f of files) {
    if (!f.endsWith("/" + MANIFEST)) continue;
    const d = f.slice(0, -MANIFEST.length - 1);
    if (rootOf(d)) dirs.push(d);
  }
  dirs.sort();
  const out = [];
  for (const d of dirs) {
    if (!out.some(r => d.startsWith(r + "/"))) out.push(d);
  }
  return out;
}

/** Every folder from just under the tree root down to the app itself. */
function chain(dir) {
  const root = rootOf(dir);
  const s = dir.split("/");
  const n = root.split("/").length;
  const out = [];
  for (let i = n + 1; i <= s.length; i++) out.push(s.slice(0, i).join("/"));
  return out;
}

const fold = p => p.normalize("NFC").toLowerCase();

function segmentProblem(seg) {
  if (seg !== seg.normalize("NFC")) {
    return {
      why: "is not in Unicode NFC (an accent typed as a separate mark): macOS and other tools store it as a different name",
      fix: seg.normalize("NFC"),
    };
  }
  if (DEVICE.test(seg)) {
    return {
      why: "is a reserved device name on Windows, where no checkout of the repository would work",
      fix: seg + "-app",
    };
  }
  if (/[. ]$/.test(seg)) {
    return {
      why: "ends with a dot or a space, which Windows cannot hold",
      fix: seg.replace(/[. ]+$/, "") || "app",
    };
  }
  if (INVALID.test(seg)) {
    return {
      why: 'contains a character Windows cannot hold in a name (: * ? " < > | \\ or a control character)',
      fix: seg.replace(/[:*?"<>|\\\u0000-\u001f]+/g, "-"),
    };
  }
  return null;
}

/**
 * The problems with the app folders "after" introduces over "before" (both
 * are file path lists). Pure.
 */
function check(beforeFiles, afterFiles) {
  const before = appDirs(beforeFiles);
  const after = appDirs(afterFiles);
  const beforeSet = new Set(before);
  // Folders that already existed: any folder on the way to an app before.
  const existed = new Set(before.flatMap(chain));
  const spellings = new Map();
  for (const folder of new Set(after.flatMap(chain))) {
    const key = fold(folder);
    if (!spellings.has(key)) spellings.set(key, new Set());
    spellings.get(key).add(folder);
  }
  const problems = [];
  const seen = new Set();
  for (const dir of after) {
    if (beforeSet.has(dir)) continue;
    for (const folder of chain(dir)) {
      if (existed.has(folder) || seen.has(folder)) continue;
      const seg = folder.split("/").pop();
      const bad = segmentProblem(seg);
      if (bad) {
        seen.add(folder);
        const to = folder.slice(0, -seg.length) + bad.fix;
        problems.push(
          '"' + folder + '": "' + seg + '" ' + bad.why + ". Rename it — git mv \"" + folder + '" "' + to + '" — commit, and push again.',
        );
        continue;
      }
      const twins = [...spellings.get(fold(folder))].filter(f => f !== folder);
      if (twins.length > 0) {
        seen.add(folder);
        problems.push(
          '"' + folder + '" and "' + twins[0] + '" differ only in upper/lower case or Unicode form, and a checkout on macOS or Windows cannot tell them apart. Rename "' + folder + '" (git mv) to a name that differs by more than that, commit, and push again.',
        );
      }
    }
  }
  return problems;
}

module.exports = { check, appDirs };

if (require.main === module) {
  const { execFileSync } = require("node:child_process");
  const git = args =>
    execFileSync("git", args, { encoding: "utf8", maxBuffer: 1 << 30 });
  const filesAt = rev => {
    if (!rev || rev === ZERO) return [];
    try {
      return git(["ls-tree", "-r", "-z", "--name-only", rev, "--", "apps", "users"])
        .split("\0")
        .filter(Boolean);
    } catch {
      return [];
    }
  };
  const resolve = ref => {
    try {
      return git(["rev-parse", "--verify", "--quiet", ref + "^{commit}"]).trim();
    } catch {
      return "";
    }
  };
  const main = process.argv[2] || "main";
  const input = require("node:fs").readFileSync(0, "utf8");
  const problems = [];
  for (const line of input.split("\n")) {
    const [oldRev, newRev, ref] = line.trim().split(/\s+/);
    if (!ref || !ref.startsWith("refs/heads/") || newRev === ZERO) continue;
    if (!resolve(newRev)) continue;
    // Already there = on the branch's previous tip, or on main.
    const before = filesAt(oldRev);
    if (ref !== "refs/heads/" + main) before.push(...filesAt(resolve("refs/heads/" + main)));
    for (const p of check(before, filesAt(newRev))) problems.push(p);
  }
  if (problems.length > 0) {
    for (const p of problems) process.stderr.write("mako: refusing " + p + "\n");
    process.stderr.write("mako: (app folders already in the repository are not affected)\n");
    process.exit(1);
  }
}
`;
