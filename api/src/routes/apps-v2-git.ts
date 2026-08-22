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
 * file is the CGI bridge and the access check, and nothing else.
 *
 * Why this exists at all: with a real remote, the sandbox is a normal machine.
 * `git push`, `git pull`, `git log`, a coding agent running inside the box —
 * all of it works because it is ordinary git, talking to an ordinary server.
 * What it replaces was a private bundle-transfer format and a shadow-commit
 * layer that existed only to move commits without a remote.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import type { Context } from "hono";
import { appsV2ReposRoot } from "../apps-v2/config";
import { repoExists } from "../apps-v2/repository.service";
import { GitTokenError, verifyGitToken } from "../apps-v2/git-token.service";
import { createRouter } from "../openapi/core";
import { loggers } from "../logging";

const logger = loggers.api("apps-v2-git");

export const appsV2GitRoutes = createRouter();

const MOUNT = "/api/apps-v2-git";

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

/** `/api/apps-v2-git/<workspaceId>.git/<rest>` -> its two parts. */
function splitPath(fullPath: string): { repo: string; rest: string } | null {
  if (!fullPath.startsWith(`${MOUNT}/`)) return null;
  const tail = fullPath.slice(MOUNT.length + 1);
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

  const repoDir = path.join(appsV2ReposRoot(), expected);
  if (!(await repoExists(repoDir))) {
    return new Response("No such repository\n", { status: 404 });
  }

  const body =
    c.req.method === "POST"
      ? Buffer.from(await c.req.arrayBuffer())
      : Buffer.alloc(0);

  return runHttpBackend({
    repoRoot: appsV2ReposRoot(),
    pathInfo: `/${expected}${parts.rest}`,
    method: c.req.method,
    query: new URL(c.req.url).search.replace(/^\?/, ""),
    contentType: c.req.header("content-type") ?? "",
    contentEncoding: c.req.header("content-encoding") ?? "",
    gitProtocol: c.req.header("git-protocol") ?? "",
    // http-backend enables receive-pack (push) for an authenticated caller.
    // Setting this IS the authorization decision, and it is also what lands in
    // the reflog, so a push is attributable.
    remoteUser: payload.userId,
    body,
  });
}

interface BackendInput {
  repoRoot: string;
  pathInfo: string;
  method: string;
  query: string;
  contentType: string;
  contentEncoding: string;
  gitProtocol: string;
  remoteUser: string;
  body: Buffer;
}

/**
 * Run git's CGI and turn its output into an HTTP response.
 *
 * CGI writes headers, a blank line, then the body — so the headers are parsed
 * out of the stream and the rest is passed through as it arrives. Buffering
 * the whole thing would have been shorter and would have meant holding an
 * entire clone in memory.
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
      CONTENT_LENGTH: String(input.body.length),
      REMOTE_USER: input.remoteUser,
      ...(input.contentEncoding
        ? { HTTP_CONTENT_ENCODING: input.contentEncoding }
        : {}),
      ...(input.gitProtocol ? { HTTP_GIT_PROTOCOL: input.gitProtocol } : {}),
    },
  });

  child.stdin.end(input.body);

  let stderr = "";
  child.stderr.on("data", chunk => {
    stderr += String(chunk).slice(0, 4000);
  });
  child.on("close", code => {
    if (code !== 0 || stderr) {
      logger.warn("git http-backend reported a problem", {
        pathInfo: input.pathInfo,
        code,
        stderr: stderr.slice(-500),
      });
    }
  });

  return new Promise<Response>((resolve, reject) => {
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
            reject(err);
          }
        });
      },
      cancel() {
        child.kill();
      },
    });
  });
}

appsV2GitRoutes.get("/*", serveGit);
appsV2GitRoutes.post("/*", serveGit);
