/**
 * Apps v2 dev preview — build the app in its session and serve the static
 * output behind a short-lived, unguessable token.
 *
 * Pilot semantics (apps-v2.md §4.7 is the end state — separate registrable
 * domain + capability tokens; this is the flag-gated dev version):
 *
 * - "Preview" = run `npm run build` in the actor's session, then serve
 *   `dist/` through /api/apps-v2-preview/:token/*.
 * - The token is minted per build, expires quickly, and is the ONLY
 *   credential: the serving route is cookie-free and the iframe embeds it
 *   with sandbox="allow-scripts" (opaque origin), so previewed app code
 *   never runs with Mako's origin or cookies.
 * - Tokens are held in-process (single-instance dev API). Fine for the
 *   pilot; a shared store comes with the E2B/multi-instance phase.
 */
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export interface PreviewGrant {
  token: string;
  workspaceId: string;
  projectId: string;
  /** Absolute directory a "static" grant serves (the session's dist/). */
  rootDir?: string;
  /** Port a "dev" grant proxies to (a live `vite dev` process). */
  devPort?: number;
  expiresAt: number;
}

const PREVIEW_TTL_MS = 30 * 60 * 1000;
const grants = new Map<string, PreviewGrant>();

function sweep(): void {
  const now = Date.now();
  for (const [token, grant] of grants) {
    if (grant.expiresAt <= now) grants.delete(token);
  }
}

function mint(
  input: { workspaceId: string; projectId: string; token?: string },
  scope: Pick<PreviewGrant, "rootDir" | "devPort">,
  dedupe: (grant: PreviewGrant) => boolean,
): PreviewGrant {
  sweep();
  // One live grant per (project, target): re-minting invalidates older
  // tokens for the same session so links don't accumulate — except a grant
  // reusing its own already-registered token (dev grants: the token is baked
  // into the running vite process's --base and must survive re-minting on
  // every "Start dev session" click against the same worktree).
  for (const [token, grant] of grants) {
    if (token !== input.token && dedupe(grant)) grants.delete(token);
  }
  const grant: PreviewGrant = {
    token: input.token ?? randomBytes(24).toString("base64url"),
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    ...scope,
    expiresAt: Date.now() + PREVIEW_TTL_MS,
  };
  grants.set(grant.token, grant);
  return grant;
}

/** Static grant: serves a built `dist/` directory as plain files. */
export function mintPreviewGrant(input: {
  workspaceId: string;
  projectId: string;
  rootDir: string;
}): PreviewGrant {
  return mint(
    input,
    { rootDir: input.rootDir },
    grant => grant.rootDir === input.rootDir,
  );
}

/**
 * Dev grant: proxies to a live `vite dev` process (see dev-server.service).
 * `token`, if given, reuses a specific value instead of minting a random one
 * — required here because the token is baked into the vite process's
 * `--base` at spawn time (so its absolute-root asset paths resolve under the
 * proxy prefix); it must stay the same across every "Start dev session"
 * click that reuses that already-running process.
 */
export function mintDevPreviewGrant(input: {
  workspaceId: string;
  projectId: string;
  devPort: number;
  token?: string;
}): PreviewGrant {
  return mint(
    input,
    { devPort: input.devPort },
    grant => grant.devPort === input.devPort,
  );
}

export function resolvePreviewGrant(token: string): PreviewGrant | null {
  sweep();
  return grants.get(token) ?? null;
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".wasm": "application/wasm",
};

export interface PreviewAsset {
  contents: Buffer;
  contentType: string;
}

/**
 * Read an asset from a grant's root with containment + SPA fallback.
 * Returns null when neither the asset nor index.html exists.
 */
export async function readPreviewAsset(
  grant: PreviewGrant,
  requestPath: string,
): Promise<PreviewAsset | null> {
  if (!grant.rootDir) return null;
  const rootDir = grant.rootDir;
  const cleaned = requestPath.replace(/^\/+/, "");
  const candidate = path.resolve(rootDir, cleaned || "index.html");
  const rel = path.relative(rootDir, candidate);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;

  const tryRead = async (abs: string): Promise<PreviewAsset | null> => {
    try {
      const stat = await fs.stat(abs);
      if (!stat.isFile()) return null;
      const contents = await fs.readFile(abs);
      const ext = path.extname(abs).toLowerCase();
      return {
        contents,
        contentType: CONTENT_TYPES[ext] ?? "application/octet-stream",
      };
    } catch {
      return null;
    }
  };

  const direct = await tryRead(candidate);
  if (direct) return direct;
  // SPA fallback for extension-less navigation paths only.
  if (!path.extname(candidate)) {
    return tryRead(path.join(rootDir, "index.html"));
  }
  return null;
}
