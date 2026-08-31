import fs from "node:fs";
import path from "node:path";
import { resolveMakoContext } from "@makoai/app-sdk/vite";

export const HOSTED_API_URL = "https://app.mako.ai";

/** Nearest ancestor holding .mako/workspace.json or .git, else null. */
export function findRepoRoot(start = process.cwd()) {
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, ".mako", "workspace.json"))) return dir;
    if (fs.existsSync(path.join(dir, ".git"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Where we are and who we talk to. `--api-url` beats MAKO_API_URL beats the
 * repo's .env beats .mako/workspace.json beats the hosted default.
 */
export function loadContext(flags = {}) {
  const repoRoot = findRepoRoot();
  const base = resolveMakoContext(repoRoot ?? process.cwd(), {
    repoRoot: repoRoot ?? process.cwd(),
    apiUrl: flags["api-url"],
    workspaceId: flags.workspace,
  });
  return {
    repoRoot,
    apiUrl: base.apiUrl || HOSTED_API_URL,
    apiKey: base.apiKey,
    workspaceId: base.workspaceId || null,
  };
}

/** apps/<slug> for a slug, a path, or the app the cwd is inside of. */
export function resolveAppDir(repoRoot, arg) {
  if (arg) {
    const direct = path.resolve(process.cwd(), arg);
    if (fs.existsSync(path.join(direct, "package.json"))) return direct;
    if (repoRoot) {
      const bySlug = path.join(repoRoot, "apps", arg);
      if (fs.existsSync(path.join(bySlug, "package.json"))) return bySlug;
    }
    throw new Error(`no app at ${arg} (expected apps/<slug>/package.json)`);
  }
  if (repoRoot) {
    const rel = path.relative(repoRoot, process.cwd()).split(path.sep);
    if (rel[0] === "apps" && rel[1]) {
      const dir = path.join(repoRoot, "apps", rel[1]);
      if (fs.existsSync(path.join(dir, "package.json"))) return dir;
    }
  }
  throw new Error("which app? run inside apps/<slug> or pass the slug: mako dev <slug>");
}
