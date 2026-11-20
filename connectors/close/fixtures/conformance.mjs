/**
 * `mako connector test` on this folder, against the recorded cassettes
 * instead of Close.
 *
 * It starts the replay server, points `__base_url` at it with a test key,
 * and runs the CLI exactly as an author would, with the fixture clock
 * preloaded into every process it starts. A request the cassettes do not
 * hold fails the read, so this also proves the conformance run sends only
 * requests the cassettes recorded.
 *
 *   node connectors/close/fixtures/conformance.mjs
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  FOLDER,
  REPO_ROOT,
  ensureFolderInstalled,
  folderEnv,
  startReplayServer,
} from "./harness.mjs";

ensureFolderInstalled();
const server = await startReplayServer();
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mako-close-conformance-"));
const config = path.join(dir, "config.json");
fs.writeFileSync(
  config,
  JSON.stringify({ api_key: "api_test_conformance", __base_url: server.url }),
);

const code = await new Promise((resolve, reject) => {
  const child = spawn(
    process.execPath,
    [
      path.join(REPO_ROOT, "packages/cli/bin/mako.js"),
      "connector",
      "test",
      FOLDER,
      "--config",
      config,
    ],
    { stdio: "inherit", env: folderEnv() },
  );
  child.on("error", reject);
  child.on("close", resolve);
});

await server.close();
fs.rmSync(dir, { recursive: true, force: true });
if (server.misses.length > 0) {
  console.error(
    `\n${server.misses.length} request(s) had no cassette:\n  ${server.misses.map(m => m.slice(0, 200)).join("\n  ")}`,
  );
}
process.exitCode = code === 0 && server.misses.length === 0 ? 0 : 1;
