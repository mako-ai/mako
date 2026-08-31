/**
 * Apps dev preview — build the app in its session and serve the static
 * output behind a short-lived, unguessable token.
 *
 * Pilot semantics (apps.md §4.7 is the end state — separate registrable
 * domain + capability tokens; this is the flag-gated dev version):
 *
 * - "Preview" = run `npm run build` in the actor's session, then serve
 *   `dist/` through /api/apps-preview/:token/*.
 * - The token is minted per build, expires quickly, and is the ONLY
 *   credential: the serving route is cookie-free and the iframe embeds it
 *   with sandbox="allow-scripts" (opaque origin), so previewed app code
 *   never runs with Mako's origin or cookies.
 * - STATIC grants (a built dist/ staged on this instance's disk) are held
 *   in-process: the directory they serve exists only on the instance that
 *   staged it, so a shared registry would buy nothing.
 * - PUBLISHED grants are STATELESS: an HMAC-signed token carrying
 *   (workspace, project, sha, expiry). Production runs many API instances
 *   behind one load balancer with no session affinity, so a token minted
 *   by one instance is routinely presented to another; when these lived in
 *   a per-process Map, every published app in production intermittently
 *   rendered "Preview expired" seconds after the token was minted. The
 *   deployment a published token names is immutable and lives in the shared
 *   artifact store, so nothing about it is instance-local — the signature
 *   is all any instance needs to trust the token.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export interface PreviewGrant {
  token: string;
  workspaceId: string;
  projectId: string;
  /** Absolute directory a "static" grant serves (the session's dist/). */
  rootDir?: string;
  /**
   * Commit whose PUBLISHED deployment this grant serves, out of the artifact
   * store rather than a directory.
   *
   * Viewing a published app needs the same cookie-free channel a preview does,
   * and for the same reason: it runs in a sandboxed, opaque-origin iframe, and
   * ES modules are always fetched in CORS mode WITHOUT credentials. A
   * cookie-authorized URL therefore 401s inside that iframe however well it
   * works in a normal tab — which looks exactly like an app that renders
   * nothing.
   */
  publishedSha?: string;
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
  scope: Pick<PreviewGrant, "rootDir">,
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
 * Published grant: serves an immutable deployment from the artifact store.
 *
 * Stateless — see the module comment. The token is `pub.<payload>.<sig>`
 * where payload is base64url JSON and sig is HMAC-SHA256 over it (same
 * construction as git-token.service). No registry, so nothing to sweep and
 * nothing to lose across instances or restarts.
 */
const PUBLISHED_TOKEN_PREFIX = "pub.";

interface PublishedTokenPayload {
  v: 1;
  w: string;
  p: string;
  s: string;
  /** Epoch milliseconds. */
  exp: number;
}

function resolveSecret(): string {
  const secret = process.env.SESSION_SECRET || process.env.ENCRYPTION_KEY;
  if (!secret) {
    throw new Error(
      "Missing HMAC secret: set SESSION_SECRET or ENCRYPTION_KEY",
    );
  }
  return secret;
}

function sign(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body).digest("base64url");
}

export function mintPublishedGrant(input: {
  workspaceId: string;
  projectId: string;
  sha: string;
}): PreviewGrant {
  const payload: PublishedTokenPayload = {
    v: 1,
    w: input.workspaceId,
    p: input.projectId,
    s: input.sha,
    exp: Date.now() + PREVIEW_TTL_MS,
  };
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString(
    "base64url",
  );
  const token = `${PUBLISHED_TOKEN_PREFIX}${body}.${sign(body, resolveSecret())}`;
  return {
    token,
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    publishedSha: input.sha,
    expiresAt: payload.exp,
  };
}

function resolvePublishedGrant(token: string): PreviewGrant | null {
  const [body, signature] = token
    .slice(PUBLISHED_TOKEN_PREFIX.length)
    .split(".");
  if (!body || !signature) return null;
  let secret: string;
  try {
    secret = resolveSecret();
  } catch {
    return null;
  }
  const expected = Buffer.from(sign(body, secret), "utf8");
  const actual = Buffer.from(signature, "utf8");
  // Length-check first: timingSafeEqual THROWS on a length mismatch rather
  // than returning false, which would turn a forged token into a 500.
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    return null;
  }
  let payload: PublishedTokenPayload;
  try {
    payload = JSON.parse(
      Buffer.from(body, "base64url").toString("utf8"),
    ) as PublishedTokenPayload;
  } catch {
    return null;
  }
  if (
    payload.v !== 1 ||
    typeof payload.w !== "string" ||
    typeof payload.p !== "string" ||
    typeof payload.s !== "string" ||
    typeof payload.exp !== "number" ||
    payload.exp <= Date.now()
  ) {
    return null;
  }
  return {
    token,
    workspaceId: payload.w,
    projectId: payload.p,
    publishedSha: payload.s,
    expiresAt: payload.exp,
  };
}

/**
 * Dev grant: proxies to a live `vite dev` process (see dev-server.service).
 * `token`, if given, reuses a specific value instead of minting a random one
 * — required here because the token is baked into the vite process's
 * `--base` at spawn time (so its absolute-root asset paths resolve under the
 * proxy prefix); it must stay the same across every "Start dev session"
 * click that reuses that already-running process.
 */
export function resolvePreviewGrant(token: string): PreviewGrant | null {
  if (token.startsWith(PUBLISHED_TOKEN_PREFIX)) {
    return resolvePublishedGrant(token);
  }
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
