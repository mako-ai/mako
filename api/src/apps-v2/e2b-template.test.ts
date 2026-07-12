import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { AppV2ScaffoldFiles } from "@mako/schemas";
import {
  APP_V2_E2B_WARMUP_COMMAND,
  APP_V2_E2B_WARMUP_FILE_NAMES,
  createAppsV2E2BTemplate,
  getAppsV2E2BTemplateWarmupFiles,
} from "./e2b-template";

function sha256(contents: string): string {
  return createHash("sha256").update(contents).digest("hex");
}

async function run(): Promise<void> {
  const warmupFiles = getAppsV2E2BTemplateWarmupFiles();
  assert.deepEqual(
    warmupFiles.map(file => file.fileName),
    [...APP_V2_E2B_WARMUP_FILE_NAMES],
  );
  for (const file of warmupFiles) {
    assert.equal(path.basename(file.sourcePath), file.fileName);
    const generated = AppV2ScaffoldFiles.find(
      candidate => candidate.path === file.fileName,
    );
    assert(generated);
    assert.equal(file.sha256, sha256(await readFile(file.sourcePath, "utf8")));
    assert.equal(file.sha256, sha256(generated.contents));
  }

  const template = createAppsV2E2BTemplate();
  const dockerfile = template.toDockerfile();
  assert.match(dockerfile, /pnpm@10\.33\.3/);
  assert.match(dockerfile, /NPM_CONFIG_USERCONFIG=\/dev\/null/);
  assert.match(dockerfile, /rm -rf \/tmp\/mako-apps-v2-warmup/);
  assert(
    dockerfile.includes(APP_V2_E2B_WARMUP_COMMAND),
    "template must run the reviewed environment-scrubbed warmup command",
  );
  const instructions = (
    template as unknown as {
      instructions: Array<{ type: string; args: string[] }>;
    }
  ).instructions;
  const warmupInstruction = instructions.find(
    instruction =>
      instruction.type === "RUN" &&
      instruction.args[0]?.includes(APP_V2_E2B_WARMUP_COMMAND),
  );
  assert(warmupInstruction);
  assert.equal(warmupInstruction.args[1], "mako");
}

void run().catch(error => {
  process.stderr.write(
    `${error instanceof Error ? error.stack : String(error)}\n`,
  );
  process.exitCode = 1;
});
