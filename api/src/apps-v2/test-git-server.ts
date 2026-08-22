/**
 * The git endpoint, on a real port, for tests.
 *
 * The sandbox is a clone now, so a test that exercises it needs something to
 * clone FROM. Pointing it at a `file://` path would be less code and would
 * test less: the interesting failures live in the HTTP surface — the CGI
 * bridge, the token check, whether push is authorized at all — and a file
 * remote skips every one of them.
 *
 * Test-only, and not imported by anything that ships.
 */
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { appsV2GitRoutes } from "../routes/apps-v2-git";

export interface TestGitServer {
  url: string;
  close(): Promise<void>;
}

export async function startTestGitServer(): Promise<TestGitServer> {
  const app = new Hono();
  app.route("/api/apps-v2-git", appsV2GitRoutes);
  return new Promise(resolve => {
    const server = serve({ fetch: app.fetch, port: 0 }, info => {
      resolve({
        url: `http://127.0.0.1:${info.port}`,
        close: () =>
          new Promise<void>(done => {
            server.close(() => done());
          }),
      });
    });
  });
}
