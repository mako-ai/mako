import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { Template } from "e2b";

const DEFAULT_ALIAS = "mako-apps-v2";
const PNPM_VERSION = "10.33.3";
const envPath = path.resolve(__dirname, "../../../.env");

if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath, override: false });
}

/**
 * Reproducible E2B template for Apps v2 tenant execution.
 */
export function createAppsV2E2BTemplate() {
  return Template()
    .fromBaseImage()
    .runCmd(
      [
        "set -eux",
        "apt-get update",
        "DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends iptables",
        "rm -rf /var/lib/apt/lists/*",
        "id -u mako >/dev/null 2>&1 || useradd --create-home --shell /bin/bash mako",
        "mkdir -p /workspace /home/mako/.cache",
        "chown -R mako:mako /workspace /home/mako",
        "chmod 0755 /workspace",
        "command -v setsid >/dev/null",
        "command -v python3 >/dev/null",
        "command -v node >/dev/null",
        `npm install -g --force pnpm@${PNPM_VERSION}`,
        `test "$(pnpm --version)" = "${PNPM_VERSION}"`,
      ].join(" && "),
      { user: "root" },
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
