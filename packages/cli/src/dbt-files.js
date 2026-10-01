// What `mako dbt run` uploads: the checkout's dbt/ folder, as the server's
// run input (api/src/dbt/local-overlay.ts).
//
// With git, only what differs from the commit the checkout forked from main
// (`git merge-base HEAD origin/main`) — staged, unstaged, untracked and
// deleted files alike, committed-but-unpushed work included, because the
// diff is from the base to the WORKING TREE. That base is a commit of the
// workspace repo, so the server has (or can fetch) it and lays these files
// over it. Without git, or without a base, the whole folder goes.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const DBT_DIR = "dbt";

/** dbt's own output and install folders: never source, often huge. */
const GENERATED_DIRS = new Set(["target", "dbt_packages", "logs", "node_modules", ".git"]);
/** The server skips larger files too (and binaries); saying so beats silence. */
const MAX_FILE_BYTES = 1_000_000;

function git(repoRoot, args) {
  return execFileSync("git", ["-C", repoRoot, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    maxBuffer: 64 * 1024 * 1024,
  });
}

function tryGit(repoRoot, args) {
  try {
    return git(repoRoot, args);
  } catch {
    return null;
  }
}

/** `dbt/models/x.sql` → `models/x.sql`; null for anything outside dbt/ or generated. */
export function projectPath(repoRelative) {
  const normalized = repoRelative.split(path.sep).join("/");
  if (!normalized.startsWith(`${DBT_DIR}/`)) return null;
  const rel = normalized.slice(DBT_DIR.length + 1);
  const first = rel.split("/")[0];
  if (!rel || GENERATED_DIRS.has(first)) return null;
  return rel;
}

/** The remote-tracking default branch: origin/HEAD's target, else origin/main. */
function upstreamDefault(repoRoot) {
  const symbolic = tryGit(repoRoot, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]);
  if (symbolic?.trim()) return symbolic.trim();
  for (const ref of ["refs/remotes/origin/main", "refs/remotes/origin/master"]) {
    if (tryGit(repoRoot, ["rev-parse", "--verify", "--quiet", ref])) return ref;
  }
  return null;
}

/** Read a file for upload, or a reason it is skipped. */
function readUploadable(absolute) {
  let stat;
  try {
    stat = fs.lstatSync(absolute);
  } catch {
    return { skip: "missing" };
  }
  if (!stat.isFile()) return { skip: "not a regular file" };
  if (stat.size > MAX_FILE_BYTES) return { skip: `larger than ${MAX_FILE_BYTES} bytes` };
  const buffer = fs.readFileSync(absolute);
  if (buffer.includes(0)) return { skip: "binary" };
  return { content: buffer.toString("utf8") };
}

function walk(dir, repoRoot, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const absolute = path.join(dir, entry.name);
    const rel = path.relative(repoRoot, absolute);
    if (entry.isDirectory()) {
      if (projectPath(`${rel}/x`) === null) continue;
      walk(absolute, repoRoot, out);
    } else if (entry.isFile()) {
      out.push(rel);
    }
  }
}

/**
 * Collect the upload. Returns `{ baseSha?, branch?, files, deletes, skipped }`
 * with project-relative paths; `skipped` lists `{ path, reason }` for files
 * the server would not accept, so the caller can warn.
 */
export function collectLocalDbtChanges(repoRoot) {
  const dbtDir = path.join(repoRoot, DBT_DIR);
  if (!fs.existsSync(path.join(dbtDir, "dbt_project.yml"))) {
    throw new Error(`no dbt project at ${dbtDir} (expected ${DBT_DIR}/dbt_project.yml)`);
  }
  const files = {};
  const deletes = [];
  const skipped = [];
  const add = repoRelative => {
    const rel = projectPath(repoRelative);
    if (rel === null) return;
    const read = readUploadable(path.join(repoRoot, repoRelative));
    if (read.skip === "missing") return;
    if (read.skip) skipped.push({ path: rel, reason: read.skip });
    else files[rel] = read.content;
  };

  const inGit = tryGit(repoRoot, ["rev-parse", "--is-inside-work-tree"])?.trim() === "true";
  const branch = inGit ? tryGit(repoRoot, ["branch", "--show-current"])?.trim() || undefined : undefined;
  const upstream = inGit ? upstreamDefault(repoRoot) : null;
  const baseSha = upstream ? tryGit(repoRoot, ["merge-base", "HEAD", upstream])?.trim() || undefined : undefined;

  if (baseSha) {
    // Base → working tree: staged + unstaged + committed-but-unpushed.
    const diff = git(repoRoot, ["diff", "--name-status", "--no-renames", "-z", baseSha, "--", DBT_DIR]);
    const parts = diff.split("\0").filter(Boolean);
    for (let i = 0; i + 1 < parts.length; i += 2) {
      const status = parts[i];
      const file = parts[i + 1];
      if (status.startsWith("D")) {
        const rel = projectPath(file);
        if (rel !== null) deletes.push(rel);
      } else {
        add(file);
      }
    }
    const untracked = git(repoRoot, ["ls-files", "--others", "--exclude-standard", "-z", "--", DBT_DIR]);
    for (const file of untracked.split("\0").filter(Boolean)) add(file);
    return { baseSha, branch, files, deletes, skipped };
  }

  // No base the server could know: the whole tree, as git sees it when it can
  // (ignored files stay out), else as the filesystem does.
  const listed = inGit
    ? git(repoRoot, ["ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", DBT_DIR])
        .split("\0")
        .filter(Boolean)
    : (() => {
        const out = [];
        walk(dbtDir, repoRoot, out);
        return out;
      })();
  for (const file of listed) add(file);
  return { branch, files, deletes, skipped };
}
