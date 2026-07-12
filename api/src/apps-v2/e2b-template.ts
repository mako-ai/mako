import dotenv from "dotenv";
import { createHash } from "node:crypto";
import fs from "fs";
import path from "path";
import { Template } from "e2b";
import { AppV2ScaffoldFiles } from "@mako/schemas";

const DEFAULT_ALIAS = "mako-apps-v2";
const PNPM_VERSION = "10.33.3";
const WARMUP_DIRECTORY = "/tmp/mako-apps-v2-warmup";
const SCAFFOLD_DIRECTORY = path.resolve(
  __dirname,
  "../../../packages/schemas/app-v2-scaffold",
);
export const APP_V2_E2B_WARMUP_FILE_NAMES = [
  "package.json",
  "pnpm-lock.yaml",
] as const;
export const APP_V2_E2B_WARMUP_COMMAND = [
  "env -i",
  "HOME=/home/mako",
  "PATH=/usr/local/bin:/usr/bin:/bin",
  "PNPM_HOME=/home/mako/.local/share/pnpm",
  "NPM_CONFIG_USERCONFIG=/dev/null",
  "pnpm fetch --frozen-lockfile",
].join(" ");
const envPath = path.resolve(__dirname, "../../../.env");

if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath, override: false });
}

function sha256(contents: string): string {
  return createHash("sha256").update(contents).digest("hex");
}

export function getAppsV2E2BTemplateWarmupFiles() {
  return APP_V2_E2B_WARMUP_FILE_NAMES.map(fileName => {
    const sourcePath = path.join(SCAFFOLD_DIRECTORY, fileName);
    const contents = fs.readFileSync(sourcePath, "utf8");
    const generated = AppV2ScaffoldFiles.find(file => file.path === fileName);
    if (!generated || sha256(contents) !== sha256(generated.contents)) {
      throw new Error(
        `Apps v2 E2B warmup file is stale relative to the generated scaffold: ${fileName}`,
      );
    }
    return {
      fileName,
      sourcePath,
      sha256: sha256(contents),
    };
  });
}

/**
 * Reproducible E2B template for Apps v2 tenant execution.
 */
export function createAppsV2E2BTemplate() {
  const warmupFiles = getAppsV2E2BTemplateWarmupFiles();
  return Template({ fileContextPath: SCAFFOLD_DIRECTORY })
    .fromBaseImage()
    .runCmd(
      [
        "set -eux",
        "apt-get update",
        "DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends iptables",
        "rm -rf /var/lib/apt/lists/*",
        "id -u mako >/dev/null 2>&1 || useradd --create-home --shell /bin/bash mako",
        "mkdir -p /workspace /home/mako/.cache",
        `mkdir -p ${WARMUP_DIRECTORY}`,
        "chown -R mako:mako /workspace /home/mako",
        `chown -R mako:mako ${WARMUP_DIRECTORY}`,
        "chmod 0755 /workspace",
        "command -v setsid >/dev/null",
        "command -v python3 >/dev/null",
        "command -v node >/dev/null",
        `npm install -g --force pnpm@${PNPM_VERSION}`,
        `test "$(pnpm --version)" = "${PNPM_VERSION}"`,
      ].join(" && "),
      { user: "root" },
    )
    .copyItems(
      warmupFiles.map(file => ({
        src: file.fileName,
        dest: `${WARMUP_DIRECTORY}/${file.fileName}`,
        forceUpload: true as const,
        user: "mako",
        mode: 0o600,
      })),
    )
    .runCmd(
      [
        "set -eux",
        `cd ${WARMUP_DIRECTORY}`,
        APP_V2_E2B_WARMUP_COMMAND,
        `rm -rf ${WARMUP_DIRECTORY} /workspace/node_modules`,
      ].join(" && "),
      { user: "mako" },
    )
    .setWorkdir("/workspace")
    .setUser("mako");
}

async function main(): Promise<void> {
  const apiKey = process.env.E2B_API_KEY?.trim();
  if (!apiKey) throw new Error("E2B_API_KEY is required");

  const alias = process.env.E2B_TEMPLATE_ALIAS?.trim() || DEFAULT_ALIAS;
  const build = await Template.build(createAppsV2E2BTemplate(), alias, {
    apiKey,
    cpuCount: 2,
    memoryMB: 1024,
  });

  // Deliberately print identifiers only. The API key is never logged.
  process.stdout.write(
    `${JSON.stringify({
      alias: build.name,
      templateId: build.templateId,
      buildId: build.buildId,
    })}\n`,
  );
}

if (require.main === module) {
  void main().catch(error => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
