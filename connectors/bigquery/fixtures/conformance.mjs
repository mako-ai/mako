/**
 * `mako connector test` on this folder, against the recorded cassettes
 * instead of BigQuery. The token exchange is emulated, with a key generated
 * for the run.
 *
 * It starts the replay server, points `api_base_url` at it with a test key,
 * and runs the CLI exactly as an author would. A request the cassettes do not
 * hold fails the read, so this also proves the conformance run sends only
 * requests the in-process connector sent when the cassettes were recorded.
 *
 *   node connectors/bigquery/fixtures/conformance.mjs
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CONNECTION_ID,
  FOLDER,
  REPO_ROOT,
  WORKSPACE_ID,
  ensureFolderInstalled,
  startReplayServer,
  testConfig,
} from "./harness.mjs";

ensureFolderInstalled();
const server = await startReplayServer();
const dir = fs.mkdtempSync(
  path.join(os.tmpdir(), "mako-bigquery-conformance-"),
);
const config = path.join(dir, "config.json");
fs.writeFileSync(
  config,
  // The ids Mako adds to every config, for the job labels the cassettes hold.
  JSON.stringify({
    ...testConfig("conformance", server),
    __connection_id: CONNECTION_ID,
    __workspace_id: WORKSPACE_ID,
  }),
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
    { stdio: "inherit" },
  );
  child.on("error", reject);
  child.on("close", resolve);
});

await server.close();
fs.rmSync(dir, { recursive: true, force: true });
if (server.misses.length > 0) {
  console.error(
    `\n${server.misses.length} request(s) had no cassette:\n  ${server.misses.join("\n  ")}`,
  );
}
process.exitCode = code === 0 && server.misses.length === 0 ? 0 : 1;
