/**
 * The workspace repository, served over git's own HTTP protocol.
 *
 * Classification: Intentionally public (token-gated). A `mgt_` git token is
 * the sole credential; there are no cookies here, because the caller is `git`
 * running inside a sandbox, not a browser.
 *
 * Plain Hono routes (NOT .openapi()): this speaks git's wire protocol, not
 * JSON, and the paths git appends are its own business.
 *
 * The server is `git http-backend` — git's CGI, the same one every git host
 * runs. Implementing the pkt-line protocol by hand was the alternative and it
 * would have been a worse version of a program already installed here. This
 * file is the CGI bridge, the access check, and the reaction to a push — and
 * nothing else.
 *
 * The reaction to a push matters more than it looks. Every way commits reach
 * the server converges HERE — the commit button, the agent's turn commit, and
 * `git push` typed in a terminal — so this is the one place that has to queue
 * the cloud mirror push (on serverless hosts the local bare repo is an
 * ephemeral cache, so an unmirrored push is a durability hole, not a stale
 * view) and poke open windows to refresh. Push-shaped side effects live here
 * and nowhere else; the commit paths in worktree.service deliberately do not
 * duplicate them.
 */
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { Context } from "hono";
import { appsReposRoot } from "../apps/config";
import {
  ensureLocalRepo,
  freshenBeforeMainWrite,
  freshenForServe,
} from "../apps/cloud-repo.service";
import { DEFAULT_BRANCH, repoExists } from "../apps/repository.service";
import { GitTokenError, verifyGitToken } from "../apps/git-token.service";
import { notifyRepoPushed } from "../apps/worktree.service";
import { createRouter } from "../openapi/core";
import { loggers } from "../logging";

const logger = loggers.api("apps-git");

export const appsGitRoutes = createRouter();

const MOUNT = "/api/apps-git";
/**
 * Pre-rename mount, still served: every sandbox cloned before the
 * apps-v2 → apps rename has this URL baked into its origin remote and
 * credential helper. Delete once those boxes are recycled.
 */
const LEGACY_MOUNT = "/api/apps-v2-git";

/** Nothing legitimate takes longer than this; a wedged CGI must not leak. */
const BACKEND_TIMEOUT_MS = 10 * 60_000;

/**
 * The pre-receive hook guarding what a NETWORK caller may do to refs.
 *
 * The rules are GitHub's defaults, not stricter: the default branch cannot be
 * force-pushed or deleted (it is production, and the cloud mirror is a forced
 * `push --mirror`, so nothing downstream would preserve the history this
 * deletes); every other branch is as free as it is on any code host, because
 * rebasing your own branch in your own sandbox is normal work. `refs/mako/*`
 * is internal bookkeeping and no network caller has business writing it.
 *
 * This guards the HTTP surface only — server-side code updates refs through
 * updateRefCas, which does not run hooks, and needs none of these limits.
 */
function preReceiveScript(): string {
  return `#!/bin/sh
# Written by Mako (apps-git). Guards network pushes; server-side ref
# updates do not run hooks and are not subject to it.
zero=0000000000000000000000000000000000000000
while read old new ref; do
  case "$ref" in
    refs/mako/*)
      echo "mako: $ref is internal and cannot be pushed to" >&2
      exit 1 ;;
    refs/heads/${DEFAULT_BRANCH})
      if [ "$new" = "$zero" ]; then
        echo "mako: refusing to delete ${DEFAULT_BRANCH} - it is the deployed branch" >&2
        exit 1
      fi
      if [ "$old" != "$zero" ] && ! git merge-base --is-ancestor "$old" "$new"; then
        echo "mako: refusing a force-push to ${DEFAULT_BRANCH} - its history is production. Merge instead." >&2
        exit 1
      fi ;;
  esac

  # Authorship: a commit this push INTRODUCES (reachable from the new tip but
  # from no ref already on the server) must be authored by the pushing user.
  # This is what makes "who changed which files" trustworthy - a caller cannot
  # push a commit forged to look like a colleague's. Commits merged in from
  # main or another branch are already on the server, so they are excluded and
  # keep their original authors. Enforced only when the endpoint supplied an
  # identity (MAKO_AUTHOR_EMAIL); an older token without one is attributed but
  # not gated, which is the pre-existing behaviour.
  # EVERY ref, not just refs/heads/*: a tag pushed first makes its commits
  # reachable, so a later branch push of the same commits introduces nothing
  # and the check never sees them — tags were a laundering route for forged
  # authorship. rev-list peels annotated tags, so the same loop covers them.
  if [ -n "$MAKO_AUTHOR_EMAIL" ] && [ "$new" != "$zero" ]; then
    for c in $(git rev-list "$new" --not --all); do
      a=$(git log -1 --format=%ae "$c")
      if [ "$a" != "$MAKO_AUTHOR_EMAIL" ]; then
        echo "mako: refusing commit $c - it is authored by <$a>, but you are pushing as <$MAKO_AUTHOR_EMAIL>." >&2
        echo "mako: Mako records who changed each file, so you can only push commits you authored." >&2
        echo "mako: fix your git identity in this box and re-commit:" >&2
        echo "mako:   git config user.email \\"$MAKO_AUTHOR_EMAIL\\" && git commit --amend --reset-author" >&2
        exit 1
      fi
    done
  fi
done
exit 0
`;
}

/**
 * Hooks directory, materialized once per process.
 *
 * The script cannot ship as a file next to this module — tsc compiles *.ts and
 * carries nothing else to dist — so the module IS the source of truth and
 * writes it out on first use. Idempotent by construction: same content, same
 * path, every boot.
 */
let hooksDirPromise: Promise<string> | null = null;
function hooksDir(): Promise<string> {
  hooksDirPromise ??= (async () => {
    const dir = path.join(os.tmpdir(), "mako-apps-git-hooks");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "pre-receive"), preReceiveScript(), {
      mode: 0o755,
    });
    return dir;
  })();
  return hooksDirPromise;
}

/**
 * Pull the token out of whatever git sends.
 *
 * A credential helper produces a username and password, which git sends as
 * Basic; the username is ignored and the password is the token. Bearer is
 * accepted too, for anything driving this directly.
 */
function tokenFrom(c: Context): string | null {
  const header = c.req.header("authorization") ?? "";
  const [scheme, value] = header.split(" ");
  if (!scheme || !value) return null;
  if (scheme.toLowerCase() === "bearer") return value.trim();
  if (scheme.toLowerCase() === "basic") {
    const decoded = Buffer.from(value, "base64").toString("utf8");
    const at = decoded.indexOf(":");
    return at === -1 ? null : decoded.slice(at + 1);
  }
  return null;
}

/**
 * 401 with a WWW-Authenticate challenge, because that is what makes git ASK
 * for credentials instead of failing outright. Without the header git reports
 * a bare "authentication failed" and never consults its credential helper.
 */
function unauthorized(): Response {
  return new Response("Unauthorized\n", {
    status: 401,
    headers: {
      "www-authenticate": 'Basic realm="Mako"',
      "content-type": "text/plain",
    },
  });
}

/** `/api/apps-git/<workspaceId>.git/<rest>` -> its two parts. */
function splitPath(fullPath: string): { repo: string; rest: string } | null {
  const mount = [MOUNT, LEGACY_MOUNT].find(m => fullPath.startsWith(`${m}/`));
  if (!mount) return null;
  const tail = fullPath.slice(mount.length + 1);
  const slash = tail.indexOf("/");
  if (slash === -1) return null;
  return { repo: tail.slice(0, slash), rest: tail.slice(slash) };
}

async function serveGit(c: Context): Promise<Response> {
  const parts = splitPath(c.req.path);
  if (!parts) return new Response("Not found\n", { status: 404 });

  const token = tokenFrom(c);
  if (!token) return unauthorized();

  let payload;
  try {
    payload = verifyGitToken(token);
  } catch (error) {
    if (error instanceof GitTokenError) return unauthorized();
    throw error;
  }

  // The token names the workspace it may touch; the URL names the one it is
  // asking for. They have to be the same repository, or a valid token for one
  // workspace would read every other workspace's code.
  const expected = `${payload.wsId}.git`;
  if (parts.repo !== expected) return unauthorized();

  // Restore the bare repo from the cloud mirror when the local cache is cold.
  // On serverless hosts APPS_GIT_ROOT starts empty after every instance
  // recycle; without this, the first `git fetch` from a long-lived sandbox
  // after a deploy would 404 on a repository that very much exists.
  await ensureLocalRepo(payload.wsId).catch(error =>
    logger.warn("Apps git: cloud restore failed; serving local state", {
      workspaceId: payload.wsId,
      error: error instanceof Error ? error.message : String(error),
    }),
  );
  const repoDir = path.join(appsReposRoot(), expected);
  if (!(await repoExists(repoDir))) {
    return new Response("No such repository\n", { status: 404 });
  }

  const isReceivePack = parts.rest === "/git-receive-pack";
  // A FETCH must see commits that landed on the mirror via another instance
  // (GitHub webhook, publish, another window's push): pull the mirror —
  // throttled — before advertising refs or answering upload-pack, or a
  // just-pushed sha is `not our ref` here even though the workspace has it.
  // A PUSH is judged against the refs advertised here, so they must be the
  // mirror's, un-throttled: a push accepted against a stale main is a
  // fast-forward of the WRONG tip — locally fine, unmirrorable forever after
  // (the mirror rejects it non-fast-forward), and the instance's publishes
  // die with it (seen in prod, 2026-09-01). The receive-pack POST itself
  // needs no freshen: git checks the client's reported old tips against the
  // refs as they are, so a ref that moved in between is refused, not clobbered.
  const service = new URL(c.req.url).searchParams.get("service");
  const isUploadPack =
    parts.rest === "/git-upload-pack" ||
    (parts.rest === "/info/refs" && service === "git-upload-pack");
  const isReceiveAdvert =
    parts.rest === "/info/refs" && service === "git-receive-pack";
  if (isUploadPack) await freshenForServe(payload.wsId);
  else if (isReceiveAdvert) await freshenBeforeMainWrite(payload.wsId);
  return runHttpBackend({
    repoRoot: appsReposRoot(),
    hooksDir: await hooksDir(),
    pathInfo: `/${expected}${parts.rest}`,
    method: c.req.method,
    query: new URL(c.req.url).search.replace(/^\?/, ""),
    contentType: c.req.header("content-type") ?? "",
    // Pass through EXACTLY what the client claimed. git http-backend inflates
    // gzip request bodies itself, and reads to EOF when no length was sent
    // (which is what a chunked push becomes once Node has dechunked it).
    contentLength: c.req.header("content-length"),
    contentEncoding: c.req.header("content-encoding") ?? "",
    gitProtocol: c.req.header("git-protocol") ?? "",
    // http-backend enables receive-pack (push) for an authenticated caller.
    // Setting this IS the authorization decision, and it is also what lands in
    // the reflog, so a push is attributable.
    remoteUser: payload.userId,
    // The address the token was minted for. The pre-receive hook rejects a
    // pushed commit authored by anyone else, so "who changed which files" is
    // trustworthy — a caller cannot forge a colleague's authorship. Absent on
    // legacy tokens minted before authorship was bound in; the hook then falls
    // back to attribution-without-enforcement rather than blocking the push.
    authorEmail: payload.email,
    body: c.req.method === "POST" ? c.req.raw.body : null,
    onSuccess: isReceivePack
      ? () => notifyRepoPushed(payload.wsId, payload.userId)
      : undefined,
  });
}

interface BackendInput {
  repoRoot: string;
  hooksDir: string;
  pathInfo: string;
  method: string;
  query: string;
  contentType: string;
  contentLength: string | undefined;
  contentEncoding: string;
  gitProtocol: string;
  remoteUser: string;
  /** Email the pushed commits must be authored by; undefined disables the check. */
  authorEmail?: string;
  /** Request body, streamed — a push can be arbitrarily large. */
  body: ReadableStream<Uint8Array> | null;
  /** Called once when a receive-pack completed cleanly (see module doc). */
  onSuccess?: () => void;
}

/**
 * Run git's CGI and turn its output into an HTTP response.
 *
 * CGI writes headers, a blank line, then the body — so the headers are parsed
 * out of the stream and the rest is passed through as it arrives. Both bodies
 * stream: buffering a clone would hold a whole repository in memory, and
 * buffering a push would hold a whole pack.
 */
function runHttpBackend(input: BackendInput): Promise<Response> {
  const child = spawn("git", ["http-backend"], {
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      GIT_PROJECT_ROOT: input.repoRoot,
      GIT_HTTP_EXPORT_ALL: "1",
      PATH_INFO: input.pathInfo,
      REQUEST_METHOD: input.method,
      QUERY_STRING: input.query,
      CONTENT_TYPE: input.contentType,
      REMOTE_USER: input.remoteUser,
      // Read by the pre-receive hook to enforce commit authorship. Set only
      // when the token carried it, so old tokens skip the check (fail-open on
      // a missing identity, never on a mismatch).
      ...(input.authorEmail ? { MAKO_AUTHOR_EMAIL: input.authorEmail } : {}),
      // Config injected per invocation instead of written into the repo:
      // it applies to exactly this serving path (updateRefCas and the mirror
      // push never see it), and there is no migration to run over existing
      // repos when it changes.
      GIT_CONFIG_COUNT: "3",
      GIT_CONFIG_KEY_0: "core.hooksPath",
      GIT_CONFIG_VALUE_0: input.hooksDir,
      // Internal bookkeeping refs are invisible to fetch AND unpushable —
      // transfer.hideRefs covers both directions. Without it, any sandbox
      // could overwrite refs/mako/publish-candidate between the trial merge
      // and the promote.
      GIT_CONFIG_KEY_1: "transfer.hideRefs",
      GIT_CONFIG_VALUE_1: "refs/mako",
      // ...but a box may still fetch a commit BY SHA. The publish build runs
      // against the trial-merge result, which by design no branch reaches
      // (main has not moved yet), so the box asks for the sha directly. The
      // token already grants every object in this workspace's repo; naming
      // one by sha reveals nothing that a clone does not.
      GIT_CONFIG_KEY_2: "uploadpack.allowAnySHA1InWant",
      GIT_CONFIG_VALUE_2: "true",
      ...(input.contentLength ? { CONTENT_LENGTH: input.contentLength } : {}),
      ...(input.contentEncoding
        ? { HTTP_CONTENT_ENCODING: input.contentEncoding }
        : {}),
      ...(input.gitProtocol ? { HTTP_GIT_PROTOCOL: input.gitProtocol } : {}),
    },
  });

  // stdin gets EPIPE whenever http-backend exits before consuming the body —
  // every auth failure and hook rejection does this with a push mid-flight.
  // Unhandled, that error event would take down the API process.
  child.stdin.on("error", () => undefined);
  if (input.body) {
    Readable.fromWeb(input.body as never)
      .on("error", () => child.kill())
      .pipe(child.stdin);
  } else {
    child.stdin.end();
  }

  // A wedged backend (or a client that stops reading a clone and never
  // disconnects) must not leak a process per request.
  const deadline = setTimeout(() => child.kill("SIGKILL"), BACKEND_TIMEOUT_MS);

  let stderr = "";
  child.stderr.on("data", chunk => {
    stderr += String(chunk).slice(0, 4000);
  });
  child.on("close", code => {
    clearTimeout(deadline);
    if (code === 0) input.onSuccess?.();
    if (code !== 0 || stderr) {
      logger.warn("git http-backend reported a problem", {
        pathInfo: input.pathInfo,
        code,
        stderr: stderr.slice(-500),
      });
    }
  });

  return new Promise<Response>(resolve => {
    let head = Buffer.alloc(0);
    let settled = false;

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        child.stdout.on("data", (chunk: Buffer) => {
          if (settled) {
            controller.enqueue(new Uint8Array(chunk));
            return;
          }
          head = Buffer.concat([head, chunk]);
          const split = head.indexOf("\r\n\r\n");
          if (split === -1) return;

          const headers = new Headers();
          let status = 200;
          for (const line of head
            .subarray(0, split)
            .toString("utf8")
            .split("\r\n")) {
            const at = line.indexOf(":");
            if (at === -1) continue;
            const name = line.slice(0, at).trim();
            const value = line.slice(at + 1).trim();
            // CGI reports its status in a header rather than a status line.
            if (name.toLowerCase() === "status") {
              status = Number.parseInt(value, 10) || 200;
            } else {
              headers.set(name, value);
            }
          }
          settled = true;
          const rest = head.subarray(split + 4);
          if (rest.length) controller.enqueue(new Uint8Array(rest));
          resolve(new Response(stream, { status, headers }));
        });

        child.stdout.on("end", () => {
          controller.close();
          if (!settled) {
            settled = true;
            resolve(
              new Response(`git http-backend produced no response\n${stderr}`, {
                status: 500,
              }),
            );
          }
        });

        child.stdout.on("error", err => {
          controller.error(err);
          if (!settled) {
            settled = true;
            resolve(new Response(`git http-backend failed\n`, { status: 500 }));
          }
        });
      },
      cancel() {
        child.kill();
      },
    });

    // Spawn failure (git not on PATH) emits 'error' on the child itself, not
    // on a stream. Unhandled it crashes the process; handled it is a 500.
    child.on("error", err => {
      clearTimeout(deadline);
      if (!settled) {
        settled = true;
        resolve(
          new Response(`could not run git http-backend: ${err.message}\n`, {
            status: 500,
          }),
        );
      }
    });
  });
}

appsGitRoutes.get("/*", serveGit);
appsGitRoutes.post("/*", serveGit);
