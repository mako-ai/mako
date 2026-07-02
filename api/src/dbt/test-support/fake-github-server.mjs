/**
 * Minimal in-memory GitHub API emulator for local dbt git-flow testing.
 *
 * Implements exactly the endpoints api/src/integrations/github/github-api.ts
 * calls (repo metadata, branches, Git Data trees/blobs/commits/refs, pull
 * requests, commit statuses) over one in-memory repo, seeded with a tiny dbt
 * project that targets the Chinook demo Postgres.
 *
 * Usage:
 *   node api/src/dbt/test-support/fake-github-server.mjs   # port 4790
 *   GITHUB_API_BASE_URL=http://127.0.0.1:4790 pnpm dev
 *
 * Then import `acme/analytics` as a GitHub dbt project (no App/token needed —
 * unauthenticated requests are accepted).
 */
/* eslint-disable no-console -- standalone dev server, not API runtime code */

import { createHash } from "node:crypto";
import { createServer } from "node:http";

const PORT = Number(process.env.FAKE_GITHUB_PORT ?? 4790);
const OWNER = "acme";
const REPO = "analytics";

/** Git blob SHA (sha1 of "blob <len>\0<content>"). */
function gitBlobSha(content) {
  const body = Buffer.from(content, "utf8");
  const header = Buffer.from(`blob ${body.length}\0`, "utf8");
  return createHash("sha1")
    .update(Buffer.concat([header, body]))
    .digest("hex");
}

function sha1(value) {
  return createHash("sha1").update(value).digest("hex");
}

// --- In-memory git object store -------------------------------------------

/** treeSha -> Map<path, content> */
const trees = new Map();
/** blobSha -> content */
const blobs = new Map();
/** commitSha -> { treeSha, parents, message } */
const commits = new Map();
/** branch -> head commit sha */
const branches = new Map();
/** number -> { headRef, baseRef, state, title, body } */
const pulls = new Map();
let pullCounter = 0;

function storeTree(files) {
  const entries = [...files.entries()].sort(([a], [b]) => a.localeCompare(b));
  const treeSha = sha1(
    entries.map(([p, c]) => `${p}:${gitBlobSha(c)}`).join("\n"),
  );
  trees.set(treeSha, new Map(files));
  for (const [, content] of entries) blobs.set(gitBlobSha(content), content);
  return treeSha;
}

function storeCommit(treeSha, parents, message) {
  const sha = sha1(`${treeSha}|${parents.join(",")}|${message}|${Date.now()}|${Math.random()}`);
  commits.set(sha, { treeSha, parents, message });
  return sha;
}

function branchFiles(branch) {
  const head = branches.get(branch);
  if (!head) return null;
  return trees.get(commits.get(head).treeSha);
}

// --- Seed: a tiny dbt project against the Chinook demo Postgres ------------

const SEED_FILES = new Map([
  [
    "dbt_project.yml",
    `name: analytics
version: "1.0.0"
profile: mako
models:
  analytics:
    +materialized: view
`,
  ],
  [
    "models/sources.yml",
    `version: 2
sources:
  - name: chinook
    schema: public
    tables:
      - name: artist
      - name: album
`,
  ],
  [
    "models/staging/stg_artists.sql",
    `select artist_id, name
from {{ source('chinook', 'artist') }}
`,
  ],
  [
    "models/staging/stg_albums.sql",
    `select album_id, title, artist_id
from {{ source('chinook', 'album') }}
`,
  ],
]);

branches.set(
  "main",
  storeCommit(storeTree(SEED_FILES), [], "chore: initial dbt project"),
);

// --- HTTP plumbing ----------------------------------------------------------

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function notFound(res, message = "Not Found") {
  json(res, 404, { message });
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function resolveTreeSha(ref) {
  // Accept: commit sha, tree sha, or branch name.
  if (commits.has(ref)) return commits.get(ref).treeSha;
  if (trees.has(ref)) return ref;
  const head = branches.get(ref);
  if (head) return commits.get(head).treeSha;
  return null;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);
  const path = decodeURIComponent(url.pathname);
  const repoPrefix = `/repos/${OWNER}/${REPO}`;
  console.log(`${req.method} ${path}`);

  try {
    if (!path.startsWith(repoPrefix)) return notFound(res);
    const sub = path.slice(repoPrefix.length);

    // GET /repos/:o/:r — repo metadata
    if (req.method === "GET" && sub === "") {
      return json(res, 200, {
        full_name: `${OWNER}/${REPO}`,
        name: REPO,
        owner: { login: OWNER },
        default_branch: "main",
        private: false,
      });
    }

    // GET /contents/... — existence checks + root listing (import UI)
    if (req.method === "GET" && sub.startsWith("/contents")) {
      const ref = url.searchParams.get("ref") ?? "main";
      const files = trees.get(resolveTreeSha(ref) ?? "");
      if (!files) return notFound(res);
      const contentPath = sub.replace(/^\/contents\/?/, "");
      if (!contentPath) {
        const roots = new Map();
        for (const p of files.keys()) {
          const [first, ...rest] = p.split("/");
          roots.set(first, rest.length > 0 ? "dir" : "file");
        }
        return json(
          res,
          200,
          [...roots.entries()].map(([name, type]) => ({
            name,
            path: name,
            type,
          })),
        );
      }
      if (files.has(contentPath)) {
        return json(res, 200, { path: contentPath, type: "file" });
      }
      return notFound(res);
    }

    // GET /branches/:name | /branches?per_page
    if (req.method === "GET" && sub.startsWith("/branches")) {
      const name = sub.slice("/branches".length).replace(/^\//, "");
      if (!name) {
        return json(
          res,
          200,
          [...branches.keys()].map(b => ({ name: b })),
        );
      }
      const head = branches.get(name);
      if (!head) return notFound(res);
      return json(res, 200, { name, commit: { sha: head } });
    }

    // GET /git/trees/:ref?recursive=1
    if (req.method === "GET" && sub.startsWith("/git/trees/")) {
      const ref = sub.slice("/git/trees/".length);
      const treeSha = resolveTreeSha(ref);
      const files = treeSha ? trees.get(treeSha) : null;
      if (!files) return notFound(res);
      return json(res, 200, {
        sha: treeSha,
        truncated: false,
        tree: [...files.entries()].map(([p, c]) => ({
          path: p,
          type: "blob",
          sha: gitBlobSha(c),
          size: Buffer.byteLength(c, "utf8"),
        })),
      });
    }

    // POST /git/trees — new tree from base + changes
    if (req.method === "POST" && sub === "/git/trees") {
      const body = await readBody(req);
      const base = trees.get(body.base_tree);
      if (!base) return notFound(res, "base_tree not found");
      const next = new Map(base);
      for (const entry of body.tree ?? []) {
        if (entry.sha === null) {
          if (!next.has(entry.path)) {
            return json(res, 422, {
              message: `GitRPC::BadObject: cannot delete missing path ${entry.path}`,
            });
          }
          next.delete(entry.path);
        } else {
          next.set(entry.path, entry.content ?? "");
        }
      }
      return json(res, 201, { sha: storeTree(next) });
    }

    // GET /git/blobs/:sha
    if (req.method === "GET" && sub.startsWith("/git/blobs/")) {
      const sha = sub.slice("/git/blobs/".length);
      const content = blobs.get(sha);
      if (content === undefined) return notFound(res);
      return json(res, 200, {
        content: Buffer.from(content, "utf8").toString("base64"),
        encoding: "base64",
      });
    }

    // GET /git/ref/heads/:branch
    if (req.method === "GET" && sub.startsWith("/git/ref/heads/")) {
      const branch = sub.slice("/git/ref/heads/".length);
      const head = branches.get(branch);
      if (!head) return notFound(res);
      return json(res, 200, { object: { sha: head } });
    }

    // GET /git/commits/:sha | POST /git/commits
    if (sub.startsWith("/git/commits")) {
      if (req.method === "GET") {
        const sha = sub.slice("/git/commits/".length);
        const commit = commits.get(sha);
        if (!commit) return notFound(res);
        return json(res, 200, { sha, tree: { sha: commit.treeSha } });
      }
      if (req.method === "POST") {
        const body = await readBody(req);
        if (!trees.has(body.tree)) return notFound(res, "tree not found");
        const sha = storeCommit(body.tree, body.parents ?? [], body.message);
        return json(res, 201, { sha });
      }
    }

    // POST /git/refs — create branch
    if (req.method === "POST" && sub === "/git/refs") {
      const body = await readBody(req);
      const branch = String(body.ref ?? "").replace(/^refs\/heads\//, "");
      if (branches.has(branch)) {
        return json(res, 422, { message: "Reference already exists" });
      }
      if (!commits.has(body.sha)) return notFound(res, "sha not found");
      branches.set(branch, body.sha);
      return json(res, 201, { ref: body.ref, object: { sha: body.sha } });
    }

    // PATCH | DELETE /git/refs/heads/:branch
    if (sub.startsWith("/git/refs/heads/")) {
      const branch = sub.slice("/git/refs/heads/".length);
      if (req.method === "PATCH") {
        const body = await readBody(req);
        if (!branches.has(branch)) return notFound(res);
        if (!commits.has(body.sha)) return notFound(res, "sha not found");
        branches.set(branch, body.sha);
        return json(res, 200, { object: { sha: body.sha } });
      }
      if (req.method === "DELETE") {
        if (!branches.has(branch)) return notFound(res);
        branches.delete(branch);
        res.writeHead(204);
        return res.end();
      }
    }

    // Pull requests
    if (req.method === "POST" && sub === "/pulls") {
      const body = await readBody(req);
      pullCounter += 1;
      pulls.set(pullCounter, {
        headRef: body.head,
        baseRef: body.base,
        state: "open",
        title: body.title,
        body: body.body ?? "",
      });
      return json(res, 201, {
        number: pullCounter,
        html_url: `http://127.0.0.1:${PORT}/${OWNER}/${REPO}/pull/${pullCounter}`,
      });
    }
    const pullMatch = sub.match(/^\/pulls\/(\d+)(\/.*)?$/);
    if (pullMatch) {
      const number = Number(pullMatch[1]);
      const pr = pulls.get(number);
      if (!pr) return notFound(res);
      if (req.method === "GET" && !pullMatch[2]) {
        return json(res, 200, {
          number,
          head: { ref: pr.headRef },
          base: { ref: pr.baseRef },
          mergeable: true,
          state: pr.state,
        });
      }
      if (req.method === "GET" && pullMatch[2]?.startsWith("/files")) {
        const headFiles = branchFiles(pr.headRef) ?? new Map();
        const baseFiles = branchFiles(pr.baseRef) ?? new Map();
        const changed = [...headFiles.entries()]
          .filter(([p, c]) => baseFiles.get(p) !== c)
          .map(([p]) => ({ filename: p }));
        return json(res, 200, changed);
      }
      if (req.method === "PUT" && pullMatch[2] === "/merge") {
        if (pr.state !== "open") {
          return json(res, 405, { message: "Pull Request is not open" });
        }
        const headFiles = branchFiles(pr.headRef);
        const baseFiles = branchFiles(pr.baseRef);
        if (!headFiles || !baseFiles) return notFound(res);
        const merged = new Map(baseFiles);
        for (const [p, c] of headFiles) merged.set(p, c);
        const treeSha = storeTree(merged);
        const sha = storeCommit(
          treeSha,
          [branches.get(pr.baseRef)],
          `Merge pull request #${number}`,
        );
        branches.set(pr.baseRef, sha);
        pr.state = "closed";
        return json(res, 200, { sha, merged: true });
      }
    }

    // POST /statuses/:sha — CI commit status (accepted + logged)
    if (req.method === "POST" && sub.startsWith("/statuses/")) {
      const body = await readBody(req);
      console.log(`  status: ${body.state} — ${body.description}`);
      return json(res, 201, {});
    }

    return notFound(res);
  } catch (error) {
    console.error("fake-github error:", error);
    return json(res, 500, { message: String(error) });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(
    `fake-github listening on http://127.0.0.1:${PORT} — repo ${OWNER}/${REPO} (default branch: main)`,
  );
});
