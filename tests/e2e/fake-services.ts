/**
 * Loopback stand-ins for the two third-party services the journey touches:
 * GitHub's REST API (App installation, token minting, repository listing) and
 * the Vercel AI Gateway behind Mako chat. The suite therefore needs no GitHub
 * App private key, and the Mako API under test gets no AI key. Started by
 * e2e.config.ts next to the API; it never contacts the network.
 */
import { createServer, type IncomingMessage } from "node:http";
import { pathToFileURL } from "node:url";

const PORT = 4791;
const ORIGIN = `http://127.0.0.1:${PORT}`;

export const FAKE_GITHUB = {
  apiBaseUrl: `${ORIGIN}/github`,
  appId: "1031",
  appSlug: "mako-e2e-fake",
  clientId: "Iv1.makoe2efake",
  installationId: 1031001,
  repo: "mako-ai/test-workspace",
} as const;
export const FAKE_AI_GATEWAY_URL = `${ORIGIN}/ai`;
/** The runner's readiness probe: 200 only once every MAKO_E2E_READY_PROBES URL answers too. */
export const FAKE_READY_URL = `${ORIGIN}/ready`;

const [owner, name] = FAKE_GITHUB.repo.split("/");
const account = { login: owner, type: "Organization" };
const repository = {
  name,
  full_name: FAKE_GITHUB.repo,
  owner: { login: owner },
  default_branch: "main",
  private: true,
};

function github(method: string, path: string): [number, unknown] {
  const id = FAKE_GITHUB.installationId;
  switch (`${method} ${path.split("?")[0]}`) {
    case `GET /app/installations/${id}`:
      return [200, { id, account, repository_selection: "selected" }];
    case `POST /app/installations/${id}/access_tokens`:
      return [
        201,
        {
          token: "fake-e2e-installation-token",
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        },
      ];
    case "GET /installation/repositories":
      return [200, { total_count: 1, repositories: [repository] }];
    case `GET /repos/${FAKE_GITHUB.repo}`:
      return [200, repository];
    default:
      return [404, { message: "Not implemented by the E2E GitHub fake" }];
  }
}

/** Mako chat's model: answers the journey's arithmetic question only. */
function languageModel(body: string, streaming: boolean) {
  const text = /19 plus 23/.test(body) ? "42" : "Mako E2E";
  const finishReason = { unified: "stop", raw: "stop" };
  const usage = {
    inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 1, text: 1, reasoning: 0 },
  };
  if (!streaming) {
    return { content: [{ type: "text", text }], finishReason, usage };
  }
  return [
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "0" },
    { type: "text-delta", id: "0", delta: text },
    { type: "text-end", id: "0" },
    { type: "finish", finishReason, usage },
  ];
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function ready(): Promise<boolean> {
  const probes = (process.env.MAKO_E2E_READY_PROBES ?? "").split(",");
  const results = await Promise.all(
    probes.map(url =>
      fetch(url, { signal: AbortSignal.timeout(5_000) }).then(
        response => response.ok,
        () => false,
      ),
    ),
  );
  return results.every(Boolean);
}

function startFakeServices() {
  createServer(async (req, res) => {
    const url = req.url ?? "/";
    const body = await readBody(req);
    const reply = (status: number, value: unknown) => {
      if (status === 404) console.error(`[e2e fake] 404 ${req.method} ${url}`);
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(value));
    };
    if (url === "/ready") {
      // 503, not 404: the runner treats any status below 500 as ready.
      return (await ready()) ? reply(200, { ready: true }) : reply(503, {});
    }
    if (url.startsWith("/github/")) {
      if (!req.headers.authorization?.startsWith("Bearer ")) {
        return reply(401, { message: "Requires authentication" });
      }
      return reply(...github(req.method ?? "GET", url.slice("/github".length)));
    }
    if (url === "/ai/language-model" && req.method === "POST") {
      const streaming = req.headers["ai-language-model-streaming"] === "true";
      const result = languageModel(body, streaming);
      if (!Array.isArray(result)) return reply(200, result);
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      for (const part of result) res.write(`data: ${JSON.stringify(part)}\n\n`);
      return res.end();
    }
    reply(404, { error: { message: "Not implemented by the E2E fake" } });
  }).listen(PORT, "127.0.0.1");
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  startFakeServices();
}
