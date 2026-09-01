/**
 * `pnpm flows:validate [<workspaceId>] [<repoDir>]` — check `flows/*.yml`
 * before pushing.
 *
 * RFC `rfcs/agent-authored-flows.md` item 1. The sync path treats an invalid
 * file as "keep the current row and move on", which is right there and leaves
 * whoever wrote the file with nothing: an agent pushes, sees green, and nothing
 * happens. A silent no-op is indistinguishable from success, so it cannot
 * self-correct.
 *
 * Exits non-zero when any file is invalid, so it composes into a pre-push hook
 * or CI. Notes (an existing slug, meaning "this edits rather than creates") are
 * printed but do not fail the run.
 */
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import mongoose from "mongoose";

import { FLOWS_DIR } from "./flow-config-files";
import { validateFlowFiles } from "./flow-validate.service";

async function main(): Promise<void> {
  const workspaceId = process.argv[2];
  const repoDir = process.argv[3] ?? process.cwd();
  if (!workspaceId) {
    throw new Error("usage: flows:validate <workspaceId> [repoDir]");
  }
  const uri = process.env.DATABASE_URL;
  if (!uri) throw new Error("DATABASE_URL is not set");

  const dir = path.join(repoDir, FLOWS_DIR);
  if (!fs.existsSync(dir)) {
    console.log(`No ${FLOWS_DIR}/ directory in ${repoDir} — nothing to check.`);
    return;
  }

  const files = fs
    .readdirSync(dir)
    .filter(f => f.endsWith(".yml") || f.endsWith(".yaml"))
    .map(f => ({
      path: `${FLOWS_DIR}/${f}`,
      contents: fs.readFileSync(path.join(dir, f), "utf8"),
    }));

  await mongoose.connect(uri);
  try {
    const result = await validateFlowFiles({ workspaceId, files });
    const notes = result.problems.filter(p => p.reason.startsWith("note:"));
    const blocking = result.problems.filter(p => !p.reason.startsWith("note:"));

    for (const n of notes) console.log(`  ${n.path}: ${n.reason}`);
    if (blocking.length > 0) {
      console.error(`\n${blocking.length} problem(s):\n`);
      for (const p of blocking) console.error(`  ${p.path}\n    ${p.reason}\n`);
    }
    console.log(
      `\n${files.length} file(s) checked, ${blocking.length} problem(s).`,
    );
    if (blocking.length > 0) {
      throw new Error(`${blocking.length} flow file(s) would not load`);
    }
  } finally {
    await mongoose.disconnect();
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  // eslint-disable-next-line no-process-exit -- operator CLI, not server code
  process.exit(1);
});
