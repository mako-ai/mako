#!/usr/bin/env node
/**
 * The runner's entry point, and the one thing it has to settle before running:
 * whether this Node can import the connector at all.
 *
 * A connector is written in TypeScript and imported directly — there is no
 * build step, on purpose, because a connector an agent just wrote has to run
 * as it stands. Node strips types from a `.ts` import unflagged only from
 * 22.18 (and 23.6); from 22.6 it needs `--experimental-strip-types`, and
 * before that it cannot do it at all. Left alone, the middle range fails with
 * `ERR_UNKNOWN_FILE_EXTENSION`, which says nothing about Node versions to
 * whoever is reading a failed sync.
 *
 * So: re-exec once with the flag where the flag is what is missing, and where
 * even that will not work, say so in the protocol rather than crashing.
 */
import { spawnSync } from "node:child_process";

const RE_EXEC_MARKER = "MAKO_CONNECTOR_TYPE_STRIPPING";

const [major, minor] = process.versions.node.split(".").map(Number);
const stripsTypesUnflagged =
  major >= 24 || (major === 23 && minor >= 6) || (major === 22 && minor >= 18);
const stripsTypesWithFlag = major === 23 || (major === 22 && minor >= 6);

if (!stripsTypesUnflagged && stripsTypesWithFlag && !process.env[RE_EXEC_MARKER]) {
  const result = spawnSync(
    process.execPath,
    ["--experimental-strip-types", ...process.argv.slice(1)],
    { stdio: "inherit", env: { ...process.env, [RE_EXEC_MARKER]: "1" } },
  );
  process.exit(result.status ?? 1);
}

if (!stripsTypesUnflagged && !stripsTypesWithFlag) {
  const { emitTraceError } = await import("../src/protocol.js");
  emitTraceError(
    `A connector is TypeScript and this is Node ${process.versions.node}, ` +
      `which cannot import it. Node 22.6+ can with a flag; 22.18+ needs none. ` +
      `Upgrade the Node running the connector.`,
  );
  process.exit(1);
}

const { main } = await import("../src/run.js");
await main();
