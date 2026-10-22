/**
 * The sandbox launcher is JavaScript generated inside a TypeScript template
 * literal, so nothing type-checks it: a doubled backslash too few and every
 * box's dev server dies at startup. Parse it with node, and drive the data
 * middleware's phase relay (binding-progress.ts) against a fake Mako.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { launcherSource } from "./dev-server.service";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mako-launcher-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("dev server launcher", () => {
  it("is valid JavaScript", () => {
    const file = path.join(tmp, "launcher.mjs");
    fs.writeFileSync(
      file,
      launcherSource("/app", 5173, "/data", "sales", "/box.env", {}),
    );
    const check = spawnSync(process.execPath, ["--check", file], {
      encoding: "utf8",
    });
    expect(check.stderr).toBe("");
    expect(check.status).toBe(0);
  });

  it("relays Mako's phases to the page, then stages the bytes", async () => {
    const dataDir = path.join(tmp, "data");
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, "sales.live"), "");
    const parquet = Buffer.from("PAR1-fresh-bytes-PAR1");

    // Fake Mako: the live-binding stream, phases then the tail.
    const mako = http.createServer((req, res) => {
      expect(req.headers.accept).toBe(
        "application/vnd.mako.live-binding-stream",
      );
      res.setHeader("content-type", "application/vnd.mako.live-binding-stream");
      res.write('{"phase":"querying_warehouse"}\n');
      res.write('{"phase":"writing_parquet","rowsWritten":5000}\n');
      res.write(
        JSON.stringify({ phase: "ready", rowCount: 7, bytes: parquet.length }) +
          "\n",
      );
      res.end(parquet);
    });
    await new Promise<void>(resolve => mako.listen(0, "127.0.0.1", resolve));
    const makoPort = (mako.address() as { port: number }).port;
    const tokenFile = path.join(tmp, "token");
    fs.writeFileSync(tokenFile, "mgt_test");
    const boxEnv = path.join(tmp, "box.env");
    fs.writeFileSync(
      boxEnv,
      `MAKO_API=http://127.0.0.1:${makoPort}\nMAKO_WS=ws1\nMAKO_TOKEN_FILE=${tokenFile}\n`,
    );

    // The launcher's own module, minus Vite: capture the middleware and
    // mount it on a bare http server.
    const source = launcherSource("/app", 5173, dataDir, "sales", boxEnv, {})
      .replace(/^import \{ createServer \} from .*$/m, "")
      .replace(/process\.on\("SIG[A-Z]+"[^\n]*\n/g, "");
    const cut = source.indexOf("const server = await createServer(");
    const harness = path.join(tmp, "harness.mjs");
    fs.writeFileSync(
      harness,
      (cut === -1 ? source : source.slice(0, cut)) + `\nexport { makoData };\n`,
    );
    const { makoData } = (await import(harness)) as {
      makoData: {
        configureServer: (server: {
          middlewares: { use: (h: http.RequestListener) => void };
        }) => void;
      };
    };
    let handler!: (
      req: http.IncomingMessage,
      res: http.ServerResponse,
      next: () => void,
    ) => void;
    makoData.configureServer({
      middlewares: { use: h => (handler = h as typeof handler) },
    });
    const box = http.createServer((req, res) =>
      handler(req, res, () => {
        res.statusCode = 404;
        res.end();
      }),
    );
    await new Promise<void>(resolve => box.listen(0, "127.0.0.1", resolve));
    const boxPort = (box.address() as { port: number }).port;
    try {
      const res = await fetch(
        `http://127.0.0.1:${boxPort}/__data/sales.parquet`,
        { headers: { accept: "application/x-ndjson" } },
      );
      expect(res.headers.get("content-type")).toBe("application/x-ndjson");
      const events = (await res.text())
        .trim()
        .split("\n")
        .map(line => JSON.parse(line));
      expect(events.map(e => e.phase)).toEqual([
        "checking",
        "querying_warehouse",
        "writing_parquet",
        "ready",
      ]);
      expect(events[2].rowsWritten).toBe(5000);
      expect(events[3]).toMatchObject({ binding: "sales", rowCount: 7 });
      expect(events[3]).not.toHaveProperty("url");
      // Staged, so the page's plain re-GET is the file, not another query.
      expect(fs.existsSync(path.join(dataDir, "sales.live"))).toBe(false);
      const again = await fetch(
        `http://127.0.0.1:${boxPort}/__data/sales.parquet`,
      );
      expect(Buffer.from(await again.arrayBuffer())).toEqual(parquet);
    } finally {
      box.close();
      mako.close();
    }
  });
});
